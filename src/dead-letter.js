import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

/**
 * DeadLetterStore persists emails that could not be delivered (permanent
 * failure, or transient failure that exhausted all retries) so they are never
 * silently lost and can be inspected or replayed manually.
 */
export class DeadLetterStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    fsSync.mkdirSync(dir, { recursive: true });
  }

  /**
   * Write a dead-letter record. `emailData` should already have its
   * attachments inlined so the record is self-contained.
   */
  async save(emailData, reason) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const id = emailData._id || "unknown";
    const file = path.join(this.dir, `${ts}_${id}.json`);
    const record = {
      deadLetteredAt: new Date().toISOString(),
      reason: String(reason || "unknown"),
      email: emailData,
    };
    await fs.writeFile(file, JSON.stringify(record, null, 2));
    this.logger.error("Email written to dead-letter queue", {
      file: path.basename(file),
      reason: record.reason,
    });
    return file;
  }

  /** Number of dead-letter records currently on disk. */
  count() {
    try {
      return fsSync
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** Most recent dead-letter filenames (newest first). */
  list(limit = 50) {
    try {
      return fsSync
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}
