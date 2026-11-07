FROM node:24-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code and scripts
COPY src ./src
COPY scripts ./scripts

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

# Expose Web Interface Port
EXPOSE 3000

# Environment defaults
ENV NODE_ENV=production
ENV WEB_PORT=3000
ENV DATABASE_PATH=/app/data/flights.db

# Run Flight Hunter service with native strip-types
CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "src/index.ts"]
