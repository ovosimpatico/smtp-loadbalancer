import nodemailer from 'nodemailer';

export class SMTPClient {
  constructor(loadBalancer, logger) {
    this.loadBalancer = loadBalancer;
    this.logger = logger;
    this.transportCache = new Map();
  }

  getTransport(provider) {
    const cacheKey = provider.name;

    // Return cached transport
    if (this.transportCache.has(cacheKey)) {
      return this.transportCache.get(cacheKey);
    }

    // Create transport
    const transport = nodemailer.createTransport({
      host: provider.host,
      port: provider.port,
      secure: provider.secure,
      auth: {
        user: provider.auth.user,
        pass: provider.auth.pass,
      },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
    });

    // Cache transport
    this.transportCache.set(cacheKey, transport);

    this.logger.debug(`Created transport for provider: ${provider.name}`);

    return transport;
  }

  async deliverEmail(emailData) {
    // Get next provider (round-robin)
    const provider = this.loadBalancer.getNextProvider();

    this.logger.info(`Attempting to deliver email via provider: ${provider.name}`, {
      from: emailData.envelope.from,
      to: emailData.envelope.to,
      subject: emailData.subject,
    });

    const transport = this.getTransport(provider);

    try {
      // Validate and sanitize attachments
      const sanitizedAttachments = (emailData.attachments || []).map((att) => {
        // Ensure content is a Buffer or string
        if (att.content && typeof att.content === 'object' && !Buffer.isBuffer(att.content)) {
          this.logger.warn('Invalid attachment content type, skipping', {
            filename: att.filename,
            type: typeof att.content,
          });
          return null;
        }
        return {
          filename: att.filename || 'attachment',
          content: att.content,
          contentType: att.contentType || 'application/octet-stream',
          encoding: att.encoding || 'base64',
        };
      }).filter(Boolean); // Remove null entries

      // FROM field with display name if available
      let fromField = provider.from;
      if (emailData.fromName) {
        // Format as "Display Name <email@address.com>"
        fromField = `${emailData.fromName} <${provider.from}>`;
      }

      // Prepare email
      const mailOptions = {
        from: fromField,
        to: emailData.envelope.to,
        subject: emailData.subject || '(No Subject)',
        text: emailData.text,
        html: emailData.html,
        headers: emailData.headers || {},
        attachments: sanitizedAttachments,

        // Reply-to original sender
        replyTo: emailData.envelope.from,
      };

      // Send email
      const info = await transport.sendMail(mailOptions);

      this.logger.info(`Email delivered successfully via ${provider.name}`, {
        messageId: info.messageId,
        response: info.response,
        from: emailData.envelope.from,
        to: emailData.envelope.to,
      });

      return {
        success: true,
        provider: provider.name,
        messageId: info.messageId,
        response: info.response,
      };
    } catch (error) {
      this.logger.error(`Failed to deliver email via ${provider.name}`, {
        error: error.message,
        code: error.code,
        from: emailData.envelope.from,
        to: emailData.envelope.to,
      });

      // Re-throw error to trigger retry
      throw new Error(
        `Delivery failed via ${provider.name}: ${error.message}`
      );
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
    const results = {};

    this.logger.info(`Verifying ${providers.length} provider(s)...`);

    for (const provider of providers) {
      results[provider.name] = await this.verifyProvider(provider);
    }

    const successCount = Object.values(results).filter((r) => r).length;
    this.logger.info(
      `Provider verification complete: ${successCount}/${providers.length} successful`
    );

    return results;
  }

  async closeAllTransports() {
    this.logger.info('Closing all SMTP transports...');

    const closePromises = [];
    for (const [name, transport] of this.transportCache.entries()) {
      if (transport && typeof transport.close === 'function') {
        const closePromise = Promise.resolve(transport.close()).catch((error) => {
          this.logger.warn(`Failed to close transport for ${name}`, {
            error: error.message,
          });
        });
        closePromises.push(closePromise);
      }
    }

    await Promise.all(closePromises);
    this.transportCache.clear();

    this.logger.info('All SMTP transports closed');
  }
}
