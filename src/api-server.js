import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ApiServer {
  constructor(config, statsManager, loadBalancer, logger) {
    this.config = config;
    this.statsManager = statsManager;
    this.loadBalancer = loadBalancer;
    this.logger = logger;
    this.app = express();
    this.server = null;
  }

  start() {
    // Default to port 8080 if not configured
    const port = this.config.api?.port || 8080;

    // Serve static files (dashboard) from public directory
    const publicPath = path.join(__dirname, "..", "public");
    this.app.use(express.static(publicPath));

    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // Stats endpoint
    this.app.get("/stats", async (req, res) => {
      try {
        const stats = await this.statsManager.getStats();
        const nextProviders = this.loadBalancer.peekNextProviders(5);

        res.json({
          providers: stats,
          next: nextProviders,
        });
      } catch (error) {
        this.logger.error("Error serving stats", { error: error.message });
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    this.server = this.app.listen(port, () => {
      this.logger.info(`API Server listening on port ${port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info("API Server stopped");
    }
  }
}
