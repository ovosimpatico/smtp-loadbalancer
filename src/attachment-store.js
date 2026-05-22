import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

/**
 * AttachmentStore spools email attachments to disk so large messages do not
 * sit in memory (or get bloated into the SQLite queue as base64). The queued
 * task only carries file paths; nodemailer streams attachments from disk.
 */
export class AttachmentStore {
  constructor(baseDir, logger) {
    this.baseDir = baseDir;
    this.logger = logger;
    fsSync.mkdirSync(baseDir, { recursive: true });
  }

  /**
   * Persist any in-memory attachment buffers to disk and return a copy of
   * emailData whose attachments reference files via `path` instead of `content`.
   */
  async spool(emailData) {
    const attachments = emailData.attachments || [];
    if (attachments.length === 0) return emailData;

    const dir = path.join(this.baseDir, emailData._id);
    await fs.mkdir(dir, { recursive: true });

    const spooled = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (att.path || att.content == null) {
        spooled.push(att);
        continue;
      }
      const filePath = path.join(dir, String(i));
      const buf = Buffer.isBuffer(att.content)
        ? att.content
        : Buffer.from(String(att.content), att.encoding || "utf8");
      await fs.writeFile(filePath, buf);
      spooled.push({
        filename: att.filename,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        contentId: att.contentId,
        path: filePath,
        size: buf.length,
      });
    }
    return { ...emailData, attachments: spooled };
  }

  /**
   * Read spooled attachment files back into base64 `content` so a record can
   * be stored self-contained (used when writing dead-letter entries).
   */
  async inline(emailData) {
    const attachments = emailData.attachments || [];
    if (attachments.length === 0) return emailData;

    const inlined = [];
    for (const att of attachments) {
      if (!att.path) {
        inlined.push(att);
        continue;
      }
      try {
        const buf = await fs.readFile(att.path);
        inlined.push({
          filename: att.filename,
          contentType: att.contentType,
          contentDisposition: att.contentDisposition,
          contentId: att.contentId,
          content: buf.toString("base64"),
          encoding: "base64",
        });
      } catch {
        inlined.push({
          filename: att.filename,
          contentType: att.contentType,
          missing: true,
        });
      }
    }
    return { ...emailData, attachments: inlined };
  }

  /** Remove all spooled files for a given email id. */
  async remove(emailId) {
    if (!emailId) return;
    await fs.rm(path.join(this.baseDir, emailId), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Delete spool directories older than maxAgeMs. These are orphans left
   * behind by a crash between spooling and queue completion.
   */
  async sweep(maxAgeMs = 24 * 60 * 60 * 1000) {
    let entries;
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const now = Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.baseDir, entry.name);
      try {
        const stat = await fs.stat(dir);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    if (removed > 0) {
      this.logger.info(`Swept ${removed} orphaned attachment spool dir(s)`);
    }
    return removed;
  }
}
