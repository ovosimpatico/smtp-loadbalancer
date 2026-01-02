import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


export function loadConfig(configPath = null) {
  const defaultPath = path.join(__dirname, '..', 'config.json');
  const finalPath = configPath || defaultPath;

  // Check for file
  if (!fs.existsSync(finalPath)) {
    throw new Error(`File not found: ${finalPath}`);
  }

  // Parse
  let config;
  try {
    const configContent = fs.readFileSync(finalPath, 'utf8');
    config = JSON.parse(configContent);
  } catch (error) {
    throw new Error(`Failed to parse: ${error.message}`);
  }

  validateConfig(config);

  return config;
}

function validateConfig(config) {
  // Validate server
  if (!config.server) {
    throw new Error('Missing "server" section');
  }

  if (!config.server.port || typeof config.server.port !== 'number') {
    throw new Error('Invalid "port" number');
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error('Port must be between 1 and 65535');
  }

  if (config.server.auth) {
    if (!config.server.auth.user || !config.server.auth.pass) {
      throw new Error('Missing "user" and "pass" fields');
    }
  }

  if (!config.providers || !Array.isArray(config.providers)) {
    throw new Error('Missing "providers" array');
  }

  if (config.providers.length === 0) {
    throw new Error('At least one provider is required');
  }

  // Validate providers
  config.providers.forEach((provider) => {
    if (!provider.name) {
      throw new Error(`Provider ${provider.name} missing "name" field`);
    }

    if (!provider.host) {
      throw new Error(`Provider "${provider.name}" missing "host" field`);
    }

    if (!provider.port || typeof provider.port !== 'number') {
      throw new Error(`Provider "${provider.name}" missing "port" field`);
    }

    if (typeof provider.secure !== 'boolean') {
      throw new Error(`Provider "${provider.name}" missing "secure" field`);
    }

    if (!provider.auth || !provider.auth.user || !provider.auth.pass) {
      throw new Error(`Provider "${provider.name}" missing "auth" credentials`);
    }

    if (!provider.from) {
      throw new Error(`Provider "${provider.name}" missing "from" field`);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(provider.from)) {
      throw new Error(`Provider "${provider.name}" has invalid "from" field`);
    }
  });

  // Validate queue
  if (!config.queue) {
    throw new Error('Missing "queue" section');
  }

  if (typeof config.queue.maxRetries !== 'number' || config.queue.maxRetries < 0) {
    throw new Error('Invalid "maxRetries" number');
  }

  if (typeof config.queue.retryDelay !== 'number' || config.queue.retryDelay < 0) {
    throw new Error('Invalid "retryDelay" number');
  }
}

export function getProvider(config, index) {
  if (index < 0 || index >= config.providers.length) {
    throw new Error(`Provider ${index} out of bounds`);
  }
  return config.providers[index];
}

export function getProviderCount(config) {
  return config.providers.length;
}
