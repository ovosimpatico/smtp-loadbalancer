import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  securityHeaders,
  basicAuth,
  rateLimiter,
} from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ApiServer {
  constructor(config, statsManager, loadBalancer, queueManager, logger) {
    this.config = config;
    this.statsManager = statsManager;
    this.loadBalancer = loadBalancer;
    this.queueManager = queueManager;
    this.logger = logger;
    this.app = express();
    this.server = null;
  }

  start() {
    const apiConfig = this.config.api || {};
    const port = apiConfig.port || 8080;
    const host = apiConfig.host || "0.0.0.0";

    this.app.disable("x-powered-by");
    this.app.set("trust proxy", true);
    this.app.use(securityHeaders);

    // Health check — intentionally public (used by the container healthcheck).
    this.app.get("/health", (req, res) => {
      const queue = this.queueManager?.getStats();
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        mode: this.config.mode || "generic",
        queue,
      });
    });

    // Everything below requires auth (if configured) and is rate limited.
    if (apiConfig.auth) {
      this.app.use(basicAuth(apiConfig.auth));
    } else {
      this.logger.warn(
        "SECURITY: the API/dashboard has no authentication (api.auth is unset) — " +
          "anyone who can reach it can view provider statistics.",
      );
    }
    this.app.use(rateLimiter({ windowMs: 60000, max: 120 }));

    // Stats endpoint (powers the dashboard).
    this.app.get("/stats", async (req, res) => {
      try {
        const stats = await this.statsManager.getStats();
        res.json({
          mode: this.config.mode || "generic",
          providers: stats,
          next: this.loadBalancer.peekNextProviders(5),
          queue: this.queueManager?.getStats(),
        });
      } catch (error) {
        this.logger.error("Error serving stats", { error: error.message });
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Prometheus-style metrics.
    this.app.get("/metrics", async (req, res) => {
      try {
        res.set("Content-Type", "text/plain; version=0.0.4");
        res.send(await this.buildMetrics());
      } catch (error) {
        this.logger.error("Error serving metrics", { error: error.message });
        res.status(500).send("# error building metrics\n");
      }
    });

    // List recent dead-letter records.
    this.app.get("/dead-letters", (req, res) => {
      res.json({
        count: this.queueManager?.deadLetters.count() || 0,
        recent: this.queueManager?.deadLetters.list(50) || [],
      });
    });

    // Static dashboard (also behind auth).
    this.app.use(express.static(path.join(__dirname, "..", "public")));

    this.server = this.app.listen(port, host, () => {
      this.logger.info(`API server listening on ${host}:${port}`, {
        auth: !!apiConfig.auth,
      });
    });
  }

  async buildMetrics() {
    const lines = [];
    const m = (name, help, type, value, labels) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      const l = labels
        ? "{" +
          Object.entries(labels)
            .map(([k, v]) => `${k}="${String(v).replace(/"/g, "")}"`)
            .join(",") +
          "}"
        : "";
      lines.push(`${name}${l} ${value}`);
    };

    const queue = this.queueManager?.getStats() || {};
    const metrics = queue.metrics || {};
    m("smtplb_queue_depth", "Emails waiting in queue", "gauge", queue.length || 0);
    m("smtplb_queue_running", "Emails currently being delivered", "gauge", queue.running || 0);
    m("smtplb_emails_delivered_total", "Total emails delivered", "counter", metrics.delivered || 0);
    m("smtplb_emails_retried_total", "Total delivery retries", "counter", metrics.retried || 0);
    m("smtplb_emails_dead_lettered_total", "Total emails dead-lettered", "counter", metrics.deadLettered || 0);
    m("smtplb_dead_letter_count", "Dead-letter records on disk", "gauge", queue.deadLetterCount || 0);

    const stats = await this.statsManager.getStats();
    for (const [name, data] of Object.entries(stats)) {
      if (data.type === "smtp2go") {
        lines.push(`smtplb_provider_daily_sent{provider="${name}"} ${data.daily_sent || 0}`);
        lines.push(`smtplb_provider_daily_remaining{provider="${name}"} ${data.daily_remaining || 0}`);
        lines.push(`smtplb_provider_monthly_remaining{provider="${name}"} ${data.cycle_remaining || 0}`);
        lines.push(`smtplb_provider_in_flight{provider="${name}"} ${data.in_flight || 0}`);
        lines.push(`smtplb_provider_hard_bounces{provider="${name}"} ${data.hard_bounces || 0}`);
        lines.push(`smtplb_provider_soft_bounces{provider="${name}"} ${data.soft_bounces || 0}`);
      } else {
        lines.push(`smtplb_provider_sent{provider="${name}"} ${data.sent || 0}`);
        lines.push(`smtplb_provider_errors{provider="${name}"} ${data.errors || 0}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info("API server stopped");
    }
  }
}
