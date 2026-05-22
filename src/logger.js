import winston from "winston";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Matches email addresses so the local-part can be masked in logs.
const EMAIL_RE =
  /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function maskEmail(str) {
  return str.replace(EMAIL_RE, (_m, first, mid, domain) => {
    const stars = "*".repeat(Math.min(Math.max(mid.length, 1), 6));
    return `${first}${stars}${domain}`;
  });
}

function redactValue(value) {
  if (typeof value === "string") return maskEmail(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}

/**
 * Create the application logger.
 *
 * @param {object} options
 * @param {boolean} [options.redactPII] Mask email addresses in log output.
 * @param {string}  [options.logsDir]   Absolute directory for log files.
 */
export function createLogger(options = {}) {
  const redactPII =
    options.redactPII ?? process.env.LOG_REDACT === "true";
  const logsDir = options.logsDir || path.join(__dirname, "..", "logs");

  const redactFormat = winston.format((info) => {
    if (!redactPII) return info;
    if (typeof info.message === "string") {
      info.message = maskEmail(info.message);
    }
    for (const key of Object.keys(info)) {
      if (key === "level" || key === "timestamp" || key === "message") continue;
      info[key] = redactValue(info[key]);
    }
    return info;
  });

  const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    redactFormat(),
    winston.format.json(),
  );

  const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    redactFormat(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let metaStr = "";
      if (Object.keys(meta).length > 0) {
        metaStr = "\n" + JSON.stringify(meta, null, 2);
      }
      return `${timestamp} [${level}]: ${message}${metaStr}`;
    }),
  );

  return winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: fileFormat,
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      new winston.transports.File({
        filename: path.join(logsDir, "combined.log"),
        maxsize: 10485760, // 10MB
        maxFiles: 5,
        tailable: true,
      }),
      new winston.transports.File({
        filename: path.join(logsDir, "error.log"),
        level: "error",
        maxsize: 10485760, // 10MB
        maxFiles: 5,
        tailable: true,
      }),
    ],
  });
}
