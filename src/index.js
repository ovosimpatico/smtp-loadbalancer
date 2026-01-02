import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { loadConfig } from './config-loader.js';
import { LoadBalancer } from './load-balancer.js';
import { QueueManager } from './queue-manager.js';
import { SMTPClient } from './smtp-client.js';
import { IncomingSMTPServer } from './smtp-server.js';
import { createLogger } from './logger.js';

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
    this.isShuttingDown = false;
  }

  async init() {
    try {
      // Create logs dir
      const logsDir = path.join(__dirname, '..', 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      this.logger = createLogger();
      this.logger.info('Starting...');

      // Load config
      const configPath = process.env.CONFIG_PATH || null;
      this.config = loadConfig(configPath);
      this.logger.info('Config OK', {
        providers: this.config.providers.length,
        serverPort: this.config.server.port,
        authEnabled: !!this.config.server.auth,
      });

      // Init load balancer
      this.loadBalancer = new LoadBalancer(this.config);
      this.logger.info('Load balancer OK', {
        strategy: 'round-robin',
        providers: this.loadBalancer.getProviderCount(),
      });

      // Init SMTP client
      this.smtpClient = new SMTPClient(this.loadBalancer, this.logger);
      this.logger.info('SMTP client OK');

      // Verify providers
      this.logger.info('Verifying providers');
      const verificationResults = await this.smtpClient.verifyAllProviders();
      const failedProviders = Object.entries(verificationResults)
        .filter(([_, success]) => !success)
        .map(([name]) => name);

      if (failedProviders.length === this.config.providers.length) {
        throw new Error('All providers failed');
      } else if (failedProviders.length > 0) {
        this.logger.warn('Some providers failed', {
          failed: failedProviders,
        });
      }

      // Init queue manager
      this.queueManager = new QueueManager(
        this.config,
        (emailData) => this.smtpClient.deliverEmail(emailData),
        this.logger
      );
      this.logger.info('Queue manager OK');

      // Start SMTP server
      this.smtpServer = new IncomingSMTPServer(
        this.config,
        this.queueManager,
        this.logger
      );
      this.smtpServer.start();

      this.logger.info('SMTP server OK', {
        serverPort: this.config.server.port,
        providers: this.config.providers.map((p) => p.name),
      });

      // Shutdown handlers
      this.setupGracefulShutdown();
    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to start', {
          error: error.message,
          stack: error.stack,
        });
      } else {
        console.error('Failed to start:', error);
      }
      process.exit(1);
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) {
        return;
      }

      this.isShuttingDown = true;
      this.logger.info(`Received ${signal}, shutting down`);

      try {
        // Stop SMTP server
        if (this.smtpServer) {
          await this.smtpServer.stop();
        }

        // Pause queue
        if (this.queueManager) {
          this.queueManager.pause();
        }

        // Wait for in-flight emails
        this.logger.info('Waiting for in-flight emails');
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Shutdown queue
        if (this.queueManager) {
          await this.queueManager.shutdown();
        }

        // Close SMTP client
        if (this.smtpClient) {
          await this.smtpClient.closeAllTransports();
        }

        this.logger.info('Shut down');
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', {
          error: error.message,
        });
        process.exit(1);
      }
    };

    // Handle signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Exception:', {
        error: error.message,
        stack: error.stack,
      });
      shutdown('uncaughtException');
    });

    // Handle promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Promise rejection:', {
        reason,
        promise,
      });
    });
  }

  getStatus() {
    return {
      server: this.smtpServer?.getStatus(),
      queue: this.queueManager?.getStats(),
      loadBalancer: {
        providers: this.loadBalancer?.getProviderCount(),
        currentIndex: this.loadBalancer?.getCurrentIndex(),
      },
    };
  }
}

// Start
const app = new SMTPLoadBalancer();
app.init().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
