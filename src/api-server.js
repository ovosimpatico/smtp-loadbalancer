import express from "express";

export class ApiServer {
  constructor(config, statsManager, logger) {
    this.config = config;
    this.statsManager = statsManager;
    this.logger = logger;
    this.app = express();
    this.server = null;
  }

  start() {
    // Default to port 8080 if not configured
    const port = this.config.api?.port || 8080;

    this.app.get("/stats", async (req, res) => {
      try {
        const stats = await this.statsManager.getStats();
        res.json(stats);
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
