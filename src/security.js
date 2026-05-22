import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison. Always performs a comparison of equal-length
 * buffers so the running time does not leak length/content information.
 */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Express middleware adding a baseline set of security headers.
 */
export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  next();
}

/**
 * Express middleware enforcing HTTP Basic auth against the supplied credentials.
 */
export function basicAuth(creds) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");

    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      // Bitwise & (not &&) so both comparisons always run — no short-circuit.
      const ok = safeEqual(user, creds.user) & safeEqual(pass, creds.pass);
      if (ok) return next();
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="SMTP Load Balancer"');
    res.status(401).json({ error: "Unauthorized" });
  };
}

/**
 * Simple in-memory fixed-window rate limiter keyed by client IP.
 */
export function rateLimiter({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (now - rec.start > windowMs) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === "function") sweep.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      rec = { start: now, count: 0 };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > max) {
      res.setHeader("Retry-After", Math.ceil((rec.start + windowMs - now) / 1000));
      return res.status(429).json({ error: "Too Many Requests" });
    }
    next();
  };
}
