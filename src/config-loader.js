import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadConfig(configPath = null) {
  const defaultPath = path.join(__dirname, "..", "config.json");
  const finalPath = configPath || defaultPath;

  if (!fs.existsSync(finalPath)) {
    throw new Error(`Config file not found: ${finalPath}`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse config: ${error.message}`);
  }

  validateConfig(config);
  return config;
}

function requireType(value, type, label) {
  if (value === undefined || value === null) return;
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return;
  }
  if (typeof value !== type) {
    throw new Error(`${label} must be of type ${type}`);
  }
}

function validateConfig(config) {
  // ----- server -----
  if (!config.server) {
    throw new Error('Missing "server" section');
  }
  if (!config.server.port || typeof config.server.port !== "number") {
    throw new Error('Invalid server "port" number');
  }
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error("server.port must be between 1 and 65535");
  }
  requireType(config.server.host, "string", "server.host");
  requireType(config.server.maxMessageSize, "number", "server.maxMessageSize");
  requireType(config.server.maxRecipients, "number", "server.maxRecipients");
  requireType(
    config.server.allowedRecipientDomains,
    "array",
    "server.allowedRecipientDomains",
  );
  requireType(config.server.trustedProxies, "array", "server.trustedProxies");
  requireType(config.server.allowInsecureAuth, "boolean", "server.allowInsecureAuth");
  requireType(config.server.useXClient, "boolean", "server.useXClient");
  requireType(config.server.useXForward, "boolean", "server.useXForward");

  if (config.server.auth) {
    if (!config.server.auth.user || !config.server.auth.pass) {
      throw new Error('server.auth requires both "user" and "pass"');
    }
  }
  if (config.server.tls) {
    const { key, cert } = config.server.tls;
    // Empty/absent tls block = TLS disabled. If one is set, require both.
    if ((key || cert) && (!key || !cert)) {
      throw new Error('server.tls requires both "key" and "cert" paths');
    }
  }

  // ----- api -----
  if (config.api) {
    requireType(config.api.port, "number", "api.port");
    requireType(config.api.host, "string", "api.host");
    if (config.api.auth && (!config.api.auth.user || !config.api.auth.pass)) {
      throw new Error('api.auth requires both "user" and "pass"');
    }
  }

  // ----- mode / providers -----
  if (config.mode && !["generic", "smtp2go"].includes(config.mode)) {
    throw new Error('Invalid "mode". Must be "generic" or "smtp2go"');
  }
  const mode = config.mode || "generic";

  if (!config.providers || !Array.isArray(config.providers)) {
    throw new Error('Missing "providers" array');
  }
  if (config.providers.length === 0) {
    throw new Error("At least one provider is required");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seenNames = new Set();

  config.providers.forEach((provider, idx) => {
    const label = provider.name || `#${idx}`;
    if (!provider.name) {
      throw new Error(`Provider ${label} missing "name" field`);
    }
    if (seenNames.has(provider.name)) {
      throw new Error(`Duplicate provider name: "${provider.name}"`);
    }
    seenNames.add(provider.name);

    if (!provider.host) {
      throw new Error(`Provider "${label}" missing "host" field`);
    }
    if (!provider.port || typeof provider.port !== "number") {
      throw new Error(`Provider "${label}" missing valid "port" field`);
    }
    if (typeof provider.secure !== "boolean") {
      throw new Error(`Provider "${label}" missing "secure" field`);
    }
    if (!provider.auth || !provider.auth.user || !provider.auth.pass) {
      throw new Error(`Provider "${label}" missing "auth" credentials`);
    }
    if (!provider.from) {
      throw new Error(`Provider "${label}" missing "from" field`);
    }
    if (!emailRegex.test(provider.from)) {
      throw new Error(`Provider "${label}" has invalid "from" address`);
    }
    if (mode === "smtp2go" && !provider.api_key) {
      throw new Error(
        `Provider "${label}" missing "api_key" (required for smtp2go mode)`,
      );
    }
    requireType(provider.daily_limit, "number", `Provider "${label}" daily_limit`);
    requireType(provider.monthly_limit, "number", `Provider "${label}" monthly_limit`);
    requireType(provider.maxConnections, "number", `Provider "${label}" maxConnections`);
  });

  // ----- queue -----
  if (!config.queue) {
    throw new Error('Missing "queue" section');
  }
  if (
    typeof config.queue.maxRetries !== "number" ||
    config.queue.maxRetries < 0
  ) {
    throw new Error('Invalid queue "maxRetries" number');
  }
  if (
    typeof config.queue.retryDelay !== "number" ||
    config.queue.retryDelay < 0
  ) {
    throw new Error('Invalid queue "retryDelay" number');
  }
  requireType(config.queue.concurrent, "number", "queue.concurrent");
  requireType(config.queue.afterProcessDelay, "number", "queue.afterProcessDelay");

  // ----- smtp2go tuning (optional) -----
  if (config.smtp2go) {
    requireType(config.smtp2go.pollIntervalMs, "number", "smtp2go.pollIntervalMs");
    requireType(config.smtp2go.apiTimeoutMs, "number", "smtp2go.apiTimeoutMs");
    requireType(config.smtp2go.dailyReserveRatio, "number", "smtp2go.dailyReserveRatio");
    requireType(config.smtp2go.errorCooldownMs, "number", "smtp2go.errorCooldownMs");
    requireType(config.smtp2go.timezone, "string", "smtp2go.timezone");
  }

  // ----- logging (optional) -----
  if (config.logging) {
    requireType(config.logging.redactPII, "boolean", "logging.redactPII");
  }
}

export function getProvider(config, index) {
  if (index < 0 || index >= config.providers.length) {
    throw new Error(`Provider index ${index} out of bounds`);
  }
  return config.providers[index];
}

export function getProviderCount(config) {
  return config.providers.length;
}
