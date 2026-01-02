import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

export class IncomingSMTPServer {
  constructor(config, queueManager, logger) {
    this.config = config;
    this.queueManager = queueManager;
    this.logger = logger;
    this.server = null;
  }

  start() {
    const serverConfig = this.config.server;

    this.server = new SMTPServer({
      // Authentication
      onAuth: (auth, session, callback) => {
        this.handleAuth(auth, session, callback);
      },

      // Email data
      onData: (stream, session, callback) => {
        this.handleData(stream, session, callback);
      },

      // Allow plain auth without TLS
      authOptional: !serverConfig.auth,
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,

      size: 25 * 1024 * 1024, // Max message size: 25MB
      useXClient: true,
      useXForward: true,

      banner: 'SMTP Ready',
      logger: false,

      // Error
      onError: (error) => {
        this.logger.error('SMTP server error', {
          error: error.message,
          code: error.code,
        });
      },
    });

    this.server.on('error', (error) => {
      this.logger.error('SMTP server error event', {
        error: error.message,
      });
    });

    this.server.listen(serverConfig.port, () => {
      this.logger.info(`SMTP server listening on port ${serverConfig.port}`, {
        authRequired: !!serverConfig.auth,
      });
    });
  }


  handleAuth(auth, session, callback) {
    const serverConfig = this.config.server;

    // accept if no auth shouldn't happen - authOptional
    if (!serverConfig.auth) {
      return callback(null, { user: 'anonymous' });
    }

    const { username, password } = auth;

    this.logger.debug('Authentication attempt', {
      username,
      remoteAddress: session.remoteAddress,
    });

    if (
      username === serverConfig.auth.user &&
      password === serverConfig.auth.pass
    ) {
      this.logger.info('Authentication successful', {
        username,
        remoteAddress: session.remoteAddress,
      });
      callback(null, { user: username });
    } else {
      this.logger.warn('Authentication failed', {
        username,
        remoteAddress: session.remoteAddress,
      });
      callback(new Error('Invalid username or password'));
    }
  }

  async handleData(stream, session, callback) {
    this.logger.info('Receiving email', {
      from: session.envelope.mailFrom?.address,
      to: session.envelope.rcptTo?.map((r) => r.address),
      remoteAddress: session.remoteAddress,
    });

    try {
      // Parse email stream
      const parsed = await simpleParser(stream);

      // Extract email
      const emailData = {
        envelope: {
          from: session.envelope.mailFrom?.address || parsed.from?.value[0]?.address,
          to: session.envelope.rcptTo?.map((r) => r.address) ||
              parsed.to?.value.map((t) => t.address) || [],
        },
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        headers: this.extractHeaders(parsed.headers),
        attachments: parsed.attachments?.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
          contentDisposition: att.contentDisposition,
          size: att.size,
        })) || [],
        messageId: parsed.messageId,
        date: parsed.date,
        receivedAt: new Date().toISOString(),
      };

      // Validate email
      if (!emailData.envelope.from) {
        throw new Error('Missing sender address');
      }

      if (!emailData.envelope.to || emailData.envelope.to.length === 0) {
        throw new Error('Missing recipient address');
      }

      this.logger.debug('Email parsed successfully', {
        from: emailData.envelope.from,
        to: emailData.envelope.to,
        subject: emailData.subject,
        hasAttachments: emailData.attachments.length > 0,
      });

      // Queue email
      await this.queueManager.enqueue(emailData);

      // Accept email
      callback(null, 'Message queued for delivery');

      this.logger.info('Email accepted and queued', {
        from: emailData.envelope.from,
        to: emailData.envelope.to,
      });
    } catch (error) {
      this.logger.error('Failed to process email', {
        error: error.message,
        from: session.envelope.mailFrom?.address,
      });

      // Reject email
      callback(new Error(`Failed to process email: ${error.message}`));
    }
  }

  extractHeaders(headers) {
    const extracted = {};

    if (!headers) return extracted;

    // Convert headers to object
    for (const [key, value] of headers) {
      // Skip headers set by upstream
      if (
        ['received', 'x-received', 'return-path', 'dkim-signature'].includes(
          key.toLowerCase()
        )
      ) {
        continue;
      }

      if (Array.isArray(extracted[key])) {
        extracted[key].push(value);
      } else if (extracted[key]) {
        extracted[key] = [extracted[key], value];
      } else {
        extracted[key] = value;
      }
    }

    return extracted;
  }

  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
      }

      this.logger.info('Stopping SMTP server...');

      this.server.close((error) => {
        if (error) {
          this.logger.error('Error stopping SMTP server', {
            error: error.message,
          });
          reject(error);
        } else {
          this.logger.info('SMTP server stopped');
          resolve();
        }
      });
    });
  }

  getStatus() {
    return {
      listening: this.server?.listening || false,
      port: this.config.server.port,
    };
  }
}
