import nodemailer from "nodemailer";

/** A 5xx SMTP reply means the message is permanently rejected — do not retry. */
function isPermanentSmtpError(error) {
  const rc = error.responseCode;
  if (typeof rc === "number" && rc >= 500 && rc < 600) return true;
  return false;
}

export class SMTPClient {
  constructor(loadBalancer, logger) {
    this.loadBalancer = loadBalancer;
    this.logger = logger;
    this.transportCache = new Map();
  }

  getTransport(provider) {
    const cacheKey = provider.name;
    if (this.transportCache.has(cacheKey)) {
      return this.transportCache.get(cacheKey);
    }

    const transport = nodemailer.createTransport({
      host: provider.host,
      port: provider.port,
      secure: provider.secure,
      auth: {
        user: provider.auth.user,
        pass: provider.auth.pass,
      },
      // Connection pooling: reuse TCP/TLS connections instead of a fresh
      // handshake per message.
      pool: provider.pool !== false,
      maxConnections: provider.maxConnections || 5,
      maxMessages: provider.maxMessages || 100,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
    });

    this.transportCache.set(cacheKey, transport);
    this.logger.debug(`Created transport for provider: ${provider.name}`);
    return transport;
  }

  /** Build nodemailer attachment objects, preserving inline (cid) images. */
  buildAttachments(emailData) {
    return (emailData.attachments || [])
      .map((att) => {
        const out = {
          filename: att.filename || "attachment",
          contentType: att.contentType || "application/octet-stream",
        };
        if (att.path) {
          out.path = att.path; // streamed from the spool directory
        } else if (att.content != null && !this._isPlainObject(att.content)) {
          out.content = att.content;
          out.encoding = att.encoding || "base64";
        } else {
          this.logger.warn("Skipping attachment with no usable content", {
            filename: att.filename,
          });
          return null;
        }
        if (att.contentId) {
          out.cid = String(att.contentId).replace(/^<|>$/g, "");
          out.contentDisposition = att.contentDisposition || "inline";
        } else if (att.contentDisposition) {
          out.contentDisposition = att.contentDisposition;
        }
        return out;
      })
      .filter(Boolean);
  }

  _isPlainObject(v) {
    return v && typeof v === "object" && !Buffer.isBuffer(v);
  }

  async deliverEmail(emailData) {
    const provider = this.loadBalancer.getNextProvider();

    // smtp2go mode can legitimately have no provider available right now
    // (all exhausted / rate-limited / cooling down) — signal a retry.
    if (!provider) {
      const err = new Error(
        "No upstream provider available (all exhausted, rate-limited, or in cooldown)",
      );
      err.retryable = true;
      throw err;
    }

    this.logger.info(`Delivering email via provider: ${provider.name}`, {
      from: emailData.envelope.from,
      to: emailData.envelope.to,
      subject: emailData.subject,
    });

    const transport = this.getTransport(provider);

    try {
      const attachments = this.buildAttachments(emailData);

      const headerTo =
        emailData.to && emailData.to.length
          ? emailData.to
          : emailData.envelope.to;
      const headerCc =
        emailData.cc && emailData.cc.length ? emailData.cc : undefined;

      const mailOptions = {
        // Provider dictates the envelope From; the original sender becomes
        // the display name + Reply-To.
        from: emailData.fromName
          ? { name: emailData.fromName, address: provider.from }
          : provider.from,
        to: headerTo,
        cc: headerCc,
        subject: emailData.subject || "(No Subject)",
        text: emailData.text || undefined,
        html: emailData.html || undefined,
        headers: emailData.headers || {},
        attachments,
        replyTo: emailData.replyTo || emailData.envelope.from,
        // Deliver to exactly the SMTP envelope recipients (covers Bcc).
        envelope: {
          from: provider.from,
          to: emailData.envelope.to,
        },
      };

      const info = await transport.sendMail(mailOptions);

      this.logger.info(`Email delivered via ${provider.name}`, {
        messageId: info.messageId,
        response: info.response,
        to: emailData.envelope.to,
      });

      return {
        success: true,
        provider: provider.name,
        messageId: info.messageId,
        response: info.response,
      };
    } catch (error) {
      const permanent = isPermanentSmtpError(error);
      this.logger.error(`Failed to deliver email via ${provider.name}`, {
        error: error.message,
        code: error.code,
        responseCode: error.responseCode,
        permanent,
      });

      const wrapped = new Error(
        `Delivery failed via ${provider.name}: ${error.message}`,
      );
      wrapped.provider = provider.name;
      wrapped.permanent = permanent;
      wrapped.code = error.code;
      wrapped.responseCode = error.responseCode;
      throw wrapped;
    }
  }

  async verifyProvider(provider) {
    const transport = this.getTransport(provider);
    try {
      await transport.verify();
      this.logger.info(`Connection OK: ${provider.name}`);
      return true;
    } catch (error) {
      this.logger.error(`Connection FAIL: ${provider.name}`, {
        error: error.message,
      });
      return false;
    }
  }

  async verifyAllProviders() {
    const providers = this.loadBalancer.getAllProviders();
    this.logger.info(`Verifying ${providers.length} provider(s)...`);

    // Verify all providers in parallel.
    const entries = await Promise.all(
      providers.map(async (p) => [p.name, await this.verifyProvider(p)]),
    );
    const results = Object.fromEntries(entries);

    const successCount = Object.values(results).filter(Boolean).length;
    this.logger.info(
      `Provider verification complete: ${successCount}/${providers.length} successful`,
    );
    return results;
  }

  async closeAllTransports() {
    this.logger.info("Closing all SMTP transports...");
    for (const [name, transport] of this.transportCache.entries()) {
      try {
        if (transport && typeof transport.close === "function") {
          transport.close();
        }
      } catch (error) {
        this.logger.warn(`Failed to close transport for ${name}`, {
          error: error.message,
        });
      }
    }
    this.transportCache.clear();
    this.logger.info("All SMTP transports closed");
  }
}
