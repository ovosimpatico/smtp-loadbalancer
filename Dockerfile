FROM node:24-alpine

# tini = proper PID 1 / signal handling; wget = healthcheck;
# su-exec = drop privileges in the entrypoint.
RUN apk add --no-cache tini wget su-exec

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY src/ ./src/
COPY public/ ./public/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Runtime directories
RUN mkdir -p /app/logs /app/data /app/config

# SMTP and HTTP/dashboard ports
EXPOSE 2525 8080

ENV CONFIG_PATH=/app/config/config.json

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/health || exit 1

# tini as PID 1 -> entrypoint fixes volume ownership -> app runs as "node".
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
