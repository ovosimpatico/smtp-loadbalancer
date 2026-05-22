import fs from "fs";
import { randomUUID } from "crypto";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { safeEqual } from "./security.js";

// Structural / address headers that must not be forwarded verbatim — they
// either conflict with the fields nodemailer rebuilds or enable spoofing.
const BLOCKED_HEADERS = new Set([
  "received",
  "x-received",
  "return-path",
  "dkim-signature",
  "x-google-dkim-signature",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "mime-version",
]);

export class IncomingSMTPServer {
  constructor(config, queueManager, logger) {
    this.config = config;
    this.queueManager = queueManager;
    this.logger = logger;
    this.server = null;
    this.tlsEnabled = false;
  }

  start() {
    const s = this.config.server;

    const options = {
      onConnect: (session, cb) => this.handleConnect(session, cb),
      onAuth: (auth, session, cb) => this.handleAuth(auth, session, cb),
      onRcptTo: (address, session, cb) =>
        this.handleRcptTo(address, session, cb),
      onData: (stream, session, cb) => this.handleData(stream, session, cb),

      authOptional: !s.auth,
      allowInsecureAuth: s.allowInsecureAuth !== false,
      secure: false,
      size: s.maxMessageSize || 25 * 1024 * 1024,

      // XCLIENT/XFORWARD let a client rewrite its own identity — only safe
      // behind a trusted proxy. Disabled unless explicitly opted into.
      useXClient: s.useXClient === true,
      useXForward: s.useXForward === true,

      banner: "SMTP Load Balancer Ready",
      logger: false,
    };

    // TLS / STARTTLS. With a cert+key, STARTTLS is offered; without one we
    // explicitly disable it (cleartext only) and warn loudly.
    if (s.tls && s.tls.key && s.tls.cert) {
      try {
        options.key = fs.readFileSync(s.tls.key);
        options.cert = fs.readFileSync(s.tls.cert);
        if (s.tls.ca) options.ca = fs.readFileSync(s.tls.ca);
        this.tlsEnabled = true;
      } catch (err) {
        throw new Error(`Failed to load TLS cert/key: ${err.message}`);
      }
    } else {
      options.disabledCommands = ["STARTTLS"];
    }

    this.server = new SMTPServer(options);

    this.server.on("error", (error) => {
      this.logger.error("SMTP server error", { error: error.message });
    });

    const host = s.host || "0.0.0.0";
    this.server.listen(s.port, host, () => {
      this.logger.info(`SMTP server listening on ${host}:${s.port}`, {
        authRequired: !!s.auth,
        tls: this.tlsEnabled,
      });
      if (!s.auth) {
        this.logger.warn(
          "SECURITY: inbound SMTP authentication is DISABLED — this server " +
            "will relay mail from ANY client. Set server.auth in config.json.",
        );
      }
      if (!this.tlsEnabled) {
        this.logger.warn(
          "SECURITY: STARTTLS is not configured — credentials and message " +
            "content cross the network in cleartext. Set server.tls in config.json.",
        );
      }
      if ((s.useXClient || s.useXForward) && !this._hasTrustedProxies()) {
        this.logger.warn(
          "SECURITY: useXClient/useXForward is enabled without " +
            "server.trustedProxies — any client can spoof its source address.",
        );
      }
    });
  }

  _hasTrustedProxies() {
    return (
      Array.isArray(this.config.server.trustedProxies) &&
      this.config.server.trustedProxies.length > 0
    );
  }

  handleConnect(session, cb) {
    const s = this.config.server;
    // If XCLIENT/XFORWARD is enabled, only accept connections from the
    // configured trusted proxies (they can forge identity otherwise).
    if ((s.useXClient || s.useXForward) && this._hasTrustedProxies()) {
      const ip = session.remoteAddress;
      if (!s.trustedProxies.includes(ip)) {
        this.logger.warn("Rejected connection: client is not a trusted proxy", {
          remoteAddress: ip,
        });
        return cb(new Error("421 Service not available"));
      }
    }
    cb();
  }

  handleAuth(auth, session, callback) {
    const s = this.config.server;
    if (!s.auth) {
      return callback(null, { user: "anonymous" });
    }

    // Constant-time comparison; bitwise & so both checks always run.
    const ok =
      safeEqual(auth.username, s.auth.user) &
      safeEqual(auth.password, s.auth.pass);

    if (ok) {
      this.logger.info("SMTP authentication successful", {
        username: auth.username,
        remoteAddress: session.remoteAddress,
      });
      callback(null, { user: auth.username });
    } else {
      this.logger.warn("SMTP authentication failed", {
        username: auth.username,
        remoteAddress: session.remoteAddress,
      });
      callback(new Error("535 Authentication credentials invalid"));
    }
  }

  handleRcptTo(address, session, callback) {
    const s = this.config.server;
    const maxRecipients = s.maxRecipients || 100;

    if (session.envelope.rcptTo.length >= maxRecipients) {
      this.logger.warn("Rejected recipient: too many recipients", {
        max: maxRecipients,
      });
      return callback(
        new Error(`452 Too many recipients (max ${maxRecipients})`),
      );
    }

    const allowed = s.allowedRecipientDomains;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const domain = (address.address.split("@")[1] || "").toLowerCase();
      const allowList = allowed.map((d) => d.toLowerCase());
      if (!allowList.includes(domain)) {
        this.logger.warn("Rejected recipient: domain not permitted", {
          recipient: address.address,
        });
        return callback(new Error("550 Recipient domain not permitted"));
      }
    }

    callback();
  }

  async handleData(stream, session, callback) {
    this.logger.info("Receiving email", {
      from: session.envelope.mailFrom?.address,
      to: session.envelope.rcptTo?.map((r) => r.address),
      remoteAddress: session.remoteAddress,
    });

    try {
      const parsed = await simpleParser(stream);

      // smtp-server flags the stream when the message exceeds `size`.
      if (stream.sizeExceeded) {
        throw new Error("Message exceeds maximum allowed size");
      }

      const emailData = {
        _id: randomUUID(),
        envelope: {
          from:
            session.envelope.mailFrom?.address ||
            parsed.from?.value?.[0]?.address,
          to: session.envelope.rcptTo?.map((r) => r.address) || [],
        },
        to: parsed.to?.value?.map((t) => t.address).filter(Boolean) || [],
        cc: parsed.cc?.value?.map((c) => c.address).filter(Boolean) || [],
        replyTo: parsed.replyTo?.value?.[0]?.address || null,
        fromName: parsed.from?.value?.[0]?.name || null,
        subject: parsed.subject || null,
        text: parsed.text || null,
        html: parsed.html || null,
        headers: this.extractHeaders(parsed.headers),
        attachments: (parsed.attachments || []).map((att) => ({
          filename: att.filename || "attachment",
          content: att.content, // Buffer — spooled to disk by QueueManager
          contentType: att.contentType,
          contentDisposition: att.contentDisposition,
          contentId: att.contentId,
        })),
        messageId: parsed.messageId || null,
        receivedAt: new Date().toISOString(),
      };

      if (!emailData.envelope.from) {
        throw new Error("Missing sender address");
      }
      if (!emailData.envelope.to || emailData.envelope.to.length === 0) {
        throw new Error("Missing recipient address");
      }

      // Drop mail where a recipient equals the sender (loop protection).
      const fromLower = emailData.envelope.from.toLowerCase();
      const loopRecipients = emailData.envelope.to.filter(
        (r) => r.toLowerCase() === fromLower,
      );
      if (loopRecipients.length > 0) {
        throw new Error("Email loop detected: sender cannot send to themselves");
      }

      // Persist to the durable queue; resolves once stored (not delivered).
      await this.queueManager.enqueue(emailData);

      callback(null, "Message accepted for delivery");
      this.logger.info("Email accepted", {
        taskId: emailData._id,
        from: emailData.envelope.from,
        to: emailData.envelope.to,
      });
    } catch (error) {
      this.logger.error("Failed to accept email", {
        error: error.message,
        from: session.envelope.mailFrom?.address,
      });
      callback(new Error(`Failed to process email: ${error.message}`));
    }
  }

  /**
   * Convert parsed headers to a plain object, dropping structural/address
   * headers and anything that isn't a clean string value.
   */
  extractHeaders(headers) {
    const extracted = {};
    if (!headers) return extracted;

    for (const [key, value] of headers) {
      const k = key.toLowerCase();
      if (BLOCKED_HEADERS.has(k)) continue;
      if (typeof value !== "string") continue; // skip structured/object values
      if (/[\r\n]/.test(value)) continue; // defensive: header-injection guard
      extracted[key] = value;
    }
    return extracted;
  }

  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.logger.info("Stopping SMTP server...");
      this.server.close((error) => {
        if (error) {
          this.logger.error("Error stopping SMTP server", {
            error: error.message,
          });
          reject(error);
        } else {
          this.logger.info("SMTP server stopped");
          resolve();
        }
      });
    });
  }

  getStatus() {
    return {
      listening: this.server?.listening || false,
      port: this.config.server.port,
      tls: this.tlsEnabled,
    };
  }
}
