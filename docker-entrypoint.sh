#!/bin/sh
# Ensure the (possibly bind-mounted) runtime directories are writable by the
# unprivileged "node" user, then drop privileges and run the app as that user.
set -e

chown -R node:node /app/data /app/logs 2>/dev/null || true

exec su-exec node "$@"
