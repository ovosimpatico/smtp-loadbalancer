import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { QueueManager } from "../src/queue-manager.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// Each test gets an isolated data directory (QueueManager reads DATA_DIR).
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smtplb-q-"));
  process.env.DATA_DIR = dir;
  return dir;
}

function makeEmail(overrides = {}) {
  return {
    _id: randomUUID(),
    envelope: { from: "sender@example.com", to: ["rcpt@example.com"] },
    subject: "test",
    attachments: [],
    ...overrides,
  };
}

const queueConfig = (over = {}) => ({
  queue: {
    maxRetries: 1,
    retryDelay: 10,
    concurrent: 2,
    afterProcessDelay: 1,
    ...over,
  },
});

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test("delivers a queued email and spools/cleans its attachment", async () => {
  freshDataDir();
  let delivered = null;
  const qm = new QueueManager(
    queueConfig(),
    async (email) => {
      delivered = email;
      return { success: true, provider: "X" };
    },
    logger,
  );

  const email = makeEmail({
    attachments: [
      { filename: "a.txt", content: Buffer.from("hello"), contentType: "text/plain" },
    ],
  });
  const id = await qm.enqueue(email);
  assert.equal(id, email._id);

  assert.ok(
    await waitFor(() => qm.getStats().metrics.delivered === 1),
    "email should be delivered",
  );
  assert.ok(delivered, "delivery handler was called");
  assert.ok(
    delivered.attachments[0].path,
    "attachment was spooled to disk (has a path)",
  );
  assert.ok(
    await waitFor(
      () => !fs.existsSync(path.join(process.env.DATA_DIR, "spool", email._id)),
    ),
    "attachment spool dir was cleaned up after delivery",
  );

  await qm.shutdown();
});

test("enqueue resolves once persisted, not once delivered", async () => {
  freshDataDir();
  let deliveredAt = 0;
  const qm = new QueueManager(
    queueConfig(),
    async () => {
      await new Promise((r) => setTimeout(r, 400));
      deliveredAt = Date.now();
      return { success: true };
    },
    logger,
  );

  const t0 = Date.now();
  await qm.enqueue(makeEmail());
  assert.ok(Date.now() - t0 < 300, "enqueue resolved before delivery finished");
  assert.equal(deliveredAt, 0, "delivery had not completed yet");

  await waitFor(() => deliveredAt > 0);
  await qm.shutdown();
});

test("dead-letters an email that fails permanently", async () => {
  freshDataDir();
  const qm = new QueueManager(
    queueConfig(),
    async () => {
      const err = new Error("550 mailbox unavailable");
      err.permanent = true;
      throw err;
    },
    logger,
  );

  await qm.enqueue(makeEmail());
  assert.ok(
    await waitFor(() => qm.getStats().deadLetterCount === 1),
    "email should be dead-lettered",
  );
  assert.equal(qm.getStats().metrics.deadLettered, 1);

  await qm.shutdown();
});

test("dead-letter record keeps the attachment content", async () => {
  const dir = freshDataDir();
  const qm = new QueueManager(
    queueConfig({ maxRetries: 1 }),
    async () => {
      throw new Error("connection reset"); // transient failure
    },
    logger,
  );

  await qm.enqueue(
    makeEmail({
      attachments: [
        {
          filename: "doc.txt",
          content: Buffer.from("secret payload"),
          contentType: "text/plain",
        },
      ],
    }),
  );
  assert.ok(await waitFor(() => qm.getStats().deadLetterCount === 1));

  const files = fs
    .readdirSync(path.join(dir, "dead-letter"))
    .filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const record = JSON.parse(
    fs.readFileSync(path.join(dir, "dead-letter", files[0]), "utf8"),
  );
  const att = record.email.attachments[0];
  assert.ok(!att.missing, "attachment should not be missing");
  assert.equal(
    Buffer.from(att.content, "base64").toString(),
    "secret payload",
    "attachment content preserved in dead-letter record",
  );

  await qm.shutdown();
});

test("retries transient failures, then dead-letters", async () => {
  freshDataDir();
  let attempts = 0;
  // maxRetries: 3 => 3 delivery attempts before giving up.
  const qm = new QueueManager(
    queueConfig({ maxRetries: 3 }),
    async () => {
      attempts++;
      throw new Error("connection timeout"); // transient, not permanent
    },
    logger,
  );

  await qm.enqueue(makeEmail());
  assert.ok(
    await waitFor(() => qm.getStats().deadLetterCount === 1, 8000),
    "email should be dead-lettered after exhausting retries",
  );
  assert.equal(attempts, 3, "should attempt delivery exactly maxRetries times");
  assert.ok(qm.getStats().metrics.retried >= 1, "retries should be counted");

  await qm.shutdown();
});
