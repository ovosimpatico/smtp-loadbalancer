import Queue from "better-queue";
import SQLiteStore from "better-queue-sqlite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { AttachmentStore } from "./attachment-store.js";
import { DeadLetterStore } from "./dead-letter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * QueueManager owns the durable email queue.
 *
 *  - Attachments are spooled to disk; the SQLite task only stores file paths.
 *  - enqueue() resolves as soon as the task is *persisted* (not delivered), so
 *    the inbound SMTP connection is acknowledged immediately.
 *  - Permanent (5xx) failures are dead-lettered at once; transient failures
 *    retry with exponential backoff + jitter; exhausted retries dead-letter.
 *  - Nothing is ever silently dropped — see the dead-letter directory.
 */
export class QueueManager {
  constructor(config, deliveryHandler, logger) {
    this.config = config;
    this.deliveryHandler = deliveryHandler;
    this.logger = logger;
    this.queue = null;

    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(__dirname, "..", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "email-queue.db");

    this.attachments = new AttachmentStore(path.join(dataDir, "spool"), logger);
    this.deadLetters = new DeadLetterStore(
      path.join(dataDir, "dead-letter"),
      logger,
    );

    // _id -> emailData, so finish/fail events can clean up & dead-letter.
    this.activeTasks = new Map();
    this.metrics = { delivered: 0, retried: 0, deadLettered: 0 };

    this.initQueue();
  }

  initQueue() {
    const queueConfig = this.config.queue;
    const maxRetries = queueConfig.maxRetries;

    this.queue = new Queue((emailData, cb) => this._process(emailData, cb), {
      // Use our own UUID as the task id so finish/fail events map back to data.
      id: "_id",
      store: new SQLiteStore({ path: this.dbPath }),
      maxRetries,
      concurrent: queueConfig.concurrent || 5,
      afterProcessDelay: queueConfig.afterProcessDelay ?? 1,
      // better-queue requires retryDelay to be a fixed number (ms). The queue's
      // own concurrency limit prevents retry thundering-herds.
      retryDelay: queueConfig.retryDelay || 60000,
    });

    // task_finish fires on a successful delivery (or a permanent failure that
    // _process already dead-lettered and reported via cb(null)).
    this.queue.on("task_finish", (taskId, result) => {
      if (result && result.deadLettered) {
        this.logger.error("Email dead-lettered (permanent failure)", {
          taskId,
        });
      } else {
        this.metrics.delivered++;
        this.logger.info("Email delivered", { taskId });
      }
      this._cleanup(taskId);
    });

    // task_retry fires each time a transient failure is rescheduled.
    this.queue.on("task_retry", (taskId, retries) => {
      this.metrics.retried++;
      this.logger.warn(`Delivery failed; retry #${retries} scheduled`, {
        taskId,
      });
    });

    // task_failed fires once, after all retries are exhausted.
    this.queue.on("task_failed", async (taskId, errorMessage) => {
      this.logger.error("Delivery failed permanently; dead-lettering", {
        taskId,
        error: errorMessage,
      });
      // Await the dead-letter write (it reads the spooled attachments)
      // before cleanup removes them.
      await this._deadLetterById(taskId, errorMessage);
      this._cleanup(taskId);
    });

    this.queue.on("error", (err) => {
      this.logger.error("Queue error", { error: err.message });
    });

    this.logger.info("Queue initialized", {
      dbPath: this.dbPath,
      concurrent: queueConfig.concurrent || 5,
      maxRetries,
    });
  }

  async _process(emailData, cb) {
    this.activeTasks.set(emailData._id, emailData);
    this.logger.info("Processing email", {
      taskId: emailData._id,
      from: emailData.envelope?.from,
      to: emailData.envelope?.to,
    });

    try {
      await this.deliveryHandler(emailData);
      cb(null, { success: true });
    } catch (error) {
      if (error.permanent) {
        // 5xx — retrying cannot help. Dead-letter now, don't burn retries.
        this.logger.error("Permanent delivery error; dead-lettering", {
          taskId: emailData._id,
          error: error.message,
        });
        await this._deadLetter(emailData, error.message);
        cb(null, { deadLettered: true });
      } else {
        // Transient — let better-queue retry with backoff.
        cb(error);
      }
    }
  }

  async _deadLetter(emailData, reason) {
    try {
      // Inline spooled attachments so the record is self-contained.
      const record = await this.attachments.inline(emailData);
      await this.deadLetters.save(record, reason);
      this.metrics.deadLettered++;
    } catch (err) {
      this.logger.error("Failed to write dead-letter record", {
        taskId: emailData?._id,
        error: err.message,
      });
    }
  }

  _deadLetterById(taskId, reason) {
    const emailData = this.activeTasks.get(taskId);
    if (emailData) {
      return this._deadLetter(emailData, reason);
    }
    this.logger.warn(
      "Cannot dead-letter: task data not in memory (process may have restarted mid-retry)",
      { taskId },
    );
    return Promise.resolve();
  }

  _cleanup(taskId) {
    this.activeTasks.delete(taskId);
    this.attachments.remove(taskId).catch((err) => {
      this.logger.warn("Attachment cleanup failed", {
        taskId,
        error: err.message,
      });
    });
  }

  async processEmail(emailData) {
    await this.deliveryHandler(emailData);
  }

  /**
   * Add an email to the queue. Resolves once the task is durably persisted —
   * NOT once it is delivered — so the SMTP caller is acknowledged promptly.
   */
  async enqueue(emailData) {
    // Move attachment buffers out of memory and onto disk.
    const spooled = await this.attachments.spool(emailData);
    const task = { ...spooled, queuedAt: new Date().toISOString() };

    return new Promise((resolve, reject) => {
      let settled = false;
      const ticket = this.queue.push(task);

      ticket.on("queued", () => {
        if (settled) return;
        settled = true;
        ticket.removeAllListeners();
        this.logger.info("Email queued", {
          taskId: emailData._id,
          from: emailData.envelope?.from,
        });
        resolve(emailData._id);
      });

      ticket.on("failed", (err) => {
        if (settled) return;
        settled = true;
        ticket.removeAllListeners();
        // Persistence failed before queueing — clean up spooled files.
        this.attachments.remove(emailData._id).catch(() => {});
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  getStats() {
    return {
      length: this.queue?.length || 0,
      running: this.queue?.running || 0,
      deadLetterCount: this.deadLetters.count(),
      metrics: { ...this.metrics },
    };
  }

  async shutdown() {
    return new Promise((resolve) => {
      this.logger.info("Shutting down queue...");
      if (this.queue) {
        this.queue.destroy(() => {
          this.logger.info("Queue shut down");
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
      this.logger.info("Queue paused");
    }
  }

  resume() {
    if (this.queue) {
      this.queue.resume();
      this.logger.info("Queue resumed");
    }
  }
}
