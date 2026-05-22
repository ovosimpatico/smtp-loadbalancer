import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { loadConfig } from "./config-loader.js";
import { LoadBalancer } from "./load-balancer.js";
import { QueueManager } from "./queue-manager.js";
import { SMTPClient } from "./smtp-client.js";
import { IncomingSMTPServer } from "./smtp-server.js";
import { StatsManager } from "./stats-manager.js";
import { ApiServer } from "./api-server.js";
import { createLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

class SMTPLoadBalancer {
  constructor() {
    this.logger = null;
    this.config = null;
    this.loadBalancer = null;
    this.smtpClient = null;
    this.queueManager = null;
    this.smtpServer = null;
    this.statsManager = null;
    this.apiServer = null;
    this.pollTimer = null;
    this.isShuttingDown = false;
  }

  async init() {
    try {
      // Ensure logs directory exists before the logger opens files.
      const logsDir = path.join(__dirname, "..", "logs");
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Load config first so logger options can come from it.
      const configPath = process.env.CONFIG_PATH || null;
      this.config = loadConfig(configPath);

      this.logger = createLogger({
        logsDir,
        redactPII: this.config.logging?.redactPII,
      });
      this.logger.info("Starting SMTP Load Balancer...");
      this.logger.info("Config loaded", {
        providers: this.config.providers.length,
        serverPort: this.config.server.port,
        authEnabled: !!this.config.server.auth,
        mode: this.config.mode || "generic",
      });

      // Stats manager + load balancer
      this.statsManager = new StatsManager(this.config, this.logger);
      this.loadBalancer = new LoadBalancer(this.config, this.statsManager);
      this.logger.info("Load balancer ready", {
        strategy:
          this.config.mode === "smtp2go" ? "quota-aware" : "round-robin",
        providers: this.loadBalancer.getProviderCount(),
      });

      // SMTP client
      this.smtpClient = new SMTPClient(this.loadBalancer, this.logger);

      // Verify providers (in parallel)
      this.logger.info("Verifying providers...");
      const verificationResults = await this.smtpClient.verifyAllProviders();
      const failedProviders = Object.entries(verificationResults)
        .filter(([, success]) => !success)
        .map(([name]) => name);

      if (failedProviders.length === this.config.providers.length) {
        throw new Error("All providers failed verification");
      } else if (failedProviders.length > 0) {
        this.logger.warn("Some providers failed verification", {
          failed: failedProviders,
        });
      }

      // Queue manager — increments stats around each delivery.
      this.queueManager = new QueueManager(
        this.config,
        async (emailData) => {
          try {
            const result = await this.smtpClient.deliverEmail(emailData);
            if (result.success && result.provider) {
              this.statsManager.incrementSent(result.provider);
            }
            return result;
          } catch (error) {
            if (error.provider) {
              this.statsManager.incrementError(error.provider, error);
            }
            throw error;
          }
        },
        this.logger,
      );

      // Clear orphaned attachment spool directories from past crashes.
      this.queueManager.attachments
        .sweep()
        .catch((err) =>
          this.logger.warn("Attachment sweep failed", { error: err.message }),
        );

      // Warm the stats cache before accepting mail (smtp2go needs it for
      // quota-aware routing).
      if (this.config.mode === "smtp2go") {
        try {
          await this.statsManager.getStats();
          this.logger.info("Initial SMTP2GO stats loaded");
        } catch (err) {
          this.logger.error("Initial stats fetch failed", {
            error: err.message,
          });
        }
      }

      // Start the inbound SMTP server.
      this.smtpServer = new IncomingSMTPServer(
        this.config,
        this.queueManager,
        this.logger,
      );
      this.smtpServer.start();

      // Start the API/dashboard server.
      this.apiServer = new ApiServer(
        this.config,
        this.statsManager,
        this.loadBalancer,
        this.queueManager,
        this.logger,
      );
      this.apiServer.start();

      // Periodic stats polling for smtp2go mode.
      if (this.config.mode === "smtp2go") {
        const interval =
          this.config.smtp2go?.pollIntervalMs || 5 * 60 * 1000;
        this.logger.info("Starting SMTP2GO stats polling", { interval });
        this.pollTimer = setInterval(() => {
          this.statsManager.getStats().catch((err) => {
            this.logger.error("Stats polling failed", { error: err.message });
          });
        }, interval);
      }

      this.setupGracefulShutdown();
      this.logger.info("SMTP Load Balancer is running");
    } catch (error) {
      if (this.logger) {
        this.logger.error("Failed to start", {
          error: error.message,
          stack: error.stack,
        });
      } else {
        console.error("Failed to start:", error);
      }
      process.exit(1);
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.logger.info(`Received ${signal}, shutting down`);

      try {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.apiServer) this.apiServer.stop();

        // Stop accepting new mail.
        if (this.smtpServer) await this.smtpServer.stop();

        // Pause the queue and let in-flight deliveries settle.
        if (this.queueManager) {
          this.queueManager.pause();
          this.logger.info("Waiting for in-flight deliveries...");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          await this.queueManager.shutdown();
        }

        if (this.smtpClient) await this.smtpClient.closeAllTransports();

        this.logger.info("Shutdown complete");
        process.exit(0);
      } catch (error) {
        this.logger.error("Error during shutdown", { error: error.message });
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    process.on("uncaughtException", (error) => {
      this.logger.error("Uncaught exception", {
        error: error.message,
        stack: error.stack,
      });
      shutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason) => {
      this.logger.error("Unhandled promise rejection", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
  }

  getStatus() {
    return {
      server: this.smtpServer?.getStatus(),
      queue: this.queueManager?.getStats(),
      loadBalancer: {
        providers: this.loadBalancer?.getProviderCount(),
      },
    };
  }
}

const app = new SMTPLoadBalancer();
app.init().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
