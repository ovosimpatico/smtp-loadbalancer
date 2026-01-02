import Queue from 'better-queue';
import SQLiteStore from 'better-queue-sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class QueueManager {
  constructor(config, deliveryHandler, logger) {
    this.config = config;
    this.deliveryHandler = deliveryHandler;
    this.logger = logger;
    this.queue = null;

    // Ensure data dir exists
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = path.join(dataDir, 'email-queue.db');
    this.initQueue();
  }

  initQueue() {
    const queueConfig = this.config.queue;

    this.queue = new Queue(
      async (emailData, cb) => {
        try {
          await this.processEmail(emailData);
          cb(null, { success: true });
        } catch (error) {
          // Return error so better-queue retries
          cb(error);
        }
      },
      {
        store: new SQLiteStore({
          path: this.dbPath,
          // Store email
          serialize: (data) => JSON.stringify(data),
          deserialize: (text) => JSON.parse(text),
        }),
        // Retry
        maxRetries: queueConfig.maxRetries,
        retryDelay: queueConfig.retryDelay,
        concurrent: 1,
        // Retry exponential backoff
        afterProcessDelay: 100,
        retryDelay: (retries) => {
          const baseDelay = queueConfig.retryDelay || 60000;
          return baseDelay * Math.pow(2, retries);
        },
      }
    );

    // Event handlers
    this.queue.on('task_finish', (taskId) => {
      this.logger.info(`Delivered successfully`, { taskId });
    });

    this.queue.on('task_failed', (taskId, errorMessage, stats) => {
      const retries = stats.attempts - 1;
      const maxRetries = queueConfig.maxRetries;

      if (retries >= maxRetries) {
        this.logger.error(`Delivery failed after ${maxRetries} retries`, {
          taskId,
          error: errorMessage,
        });
      } else {
        this.logger.warn(`Delivery attempt ${stats.attempts} failed, will retry`, {
          taskId,
          error: errorMessage,
          nextRetryIn: this.queue.options.retryDelay(retries),
        });
      }
    });

    this.queue.on('task_progress', (taskId, completed, total) => {
      this.logger.debug(`Progress: ${completed}/${total}`, { taskId });
    });

    this.logger.info('Queue initialized', { dbPath: this.dbPath });
  }

  async processEmail(emailData) {
    this.logger.info('Processing email', {
      from: emailData.envelope.from,
      to: emailData.envelope.to,
      subject: emailData.subject,
    });

    // Call SMTP client
    await this.deliveryHandler(emailData);
  }

  enqueue(emailData) {
    return new Promise((resolve, reject) => {
      // Add metadata to email
      const queuedEmail = {
        ...emailData,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };

      this.queue.push(queuedEmail, (error, result) => {
        if (error) {
          this.logger.error('Failed to queue', { error: error.message });
          reject(error);
        } else {
          this.logger.info('Queued successfully', {
            from: emailData.envelope.from,
            to: emailData.envelope.to,
          });
          resolve(result);
        }
      });
    });
  }

  getStats() {
    return {
      length: this.queue.length,
      running: this.queue.running,
    };
  }

  async shutdown() {
    return new Promise((resolve) => {
      this.logger.info('Shutting down...');

      if (this.queue) {
        this.queue.destroy(() => {
          this.logger.info('Shut down');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  pause() {
    if (this.queue) {
      this.queue.pause();
      this.logger.info('Paused');
    }
  }

  resume() {
    if (this.queue) {
      this.queue.resume();
      this.logger.info('Resumed');
    }
  }
}
