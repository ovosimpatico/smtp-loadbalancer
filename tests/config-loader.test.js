import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig } from "../src/config-loader.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtplb-test-"));

function writeConfig(obj) {
  const file = path.join(tmpDir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

const validConfig = {
  mode: "generic",
  server: { port: 2525, auth: { user: "a", pass: "b" } },
  providers: [
    {
      name: "P1",
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "u", pass: "p" },
      from: "noreply@example.com",
    },
  ],
  queue: { maxRetries: 5, retryDelay: 60000 },
};

test("loads a valid config", () => {
  const cfg = loadConfig(writeConfig(validConfig));
  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.server.port, 2525);
});

test("rejects a missing file", () => {
  assert.throws(() => loadConfig("/no/such/file.json"), /not found/);
});

test("rejects an out-of-range port", () => {
  const bad = { ...validConfig, server: { ...validConfig.server, port: 99999 } };
  assert.throws(() => loadConfig(writeConfig(bad)), /between 1 and 65535/);
});

test("rejects an empty providers array", () => {
  const bad = { ...validConfig, providers: [] };
  assert.throws(() => loadConfig(writeConfig(bad)), /At least one provider/);
});

test("rejects duplicate provider names", () => {
  const bad = {
    ...validConfig,
    providers: [validConfig.providers[0], validConfig.providers[0]],
  };
  assert.throws(() => loadConfig(writeConfig(bad)), /Duplicate provider name/);
});

test("rejects an invalid from address", () => {
  const bad = {
    ...validConfig,
    providers: [{ ...validConfig.providers[0], from: "not-an-email" }],
  };
  assert.throws(() => loadConfig(writeConfig(bad)), /invalid "from"/);
});

test("requires api_key in smtp2go mode", () => {
  const bad = { ...validConfig, mode: "smtp2go" };
  assert.throws(() => loadConfig(writeConfig(bad)), /api_key/);
});

test("rejects server.tls without a cert", () => {
  const bad = {
    ...validConfig,
    server: { ...validConfig.server, tls: { key: "/k.pem" } },
  };
  assert.throws(() => loadConfig(writeConfig(bad)), /tls requires/);
});

test("accepts optional tuning fields", () => {
  const cfg = loadConfig(
    writeConfig({
      ...validConfig,
      queue: { ...validConfig.queue, concurrent: 10, afterProcessDelay: 0 },
      api: { port: 9000, auth: { user: "x", pass: "y" } },
    }),
  );
  assert.equal(cfg.queue.concurrent, 10);
  assert.equal(cfg.api.port, 9000);
});

test("rejects a wrongly-typed optional field", () => {
  const bad = {
    ...validConfig,
    queue: { ...validConfig.queue, concurrent: "lots" },
  };
  assert.throws(() => loadConfig(writeConfig(bad)), /concurrent must be/);
});
