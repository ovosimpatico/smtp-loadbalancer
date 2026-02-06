FROM node:24-alpine

# Install netcat for healthcheck
RUN apk add --no-cache netcat-openbsd

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY src/ ./src/
COPY public/ ./public/

# Create directories for logs and data
RUN mkdir -p /app/logs /app/data

# Expose SMTP and HTTP ports
EXPOSE 2525 8080

# Set environment variable for config path
ENV CONFIG_PATH=/app/config/config.json

# Run the application
CMD ["node", "src/index.js"]
