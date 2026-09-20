# FunkFactoryOS — Homelab Dockerfile
# Node.js 18 LTS on Alpine (small image, fast builds)
FROM node:18-alpine

# Native build deps (required by some npm packages)
RUN apk add --no-cache python3 make g++ wget

WORKDIR /app

# Install dependencies first (layer cache — only rebuilds on package.json change)
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Ensure uploads directory exists inside the image
# (gets overlaid by the volume mount at runtime)
RUN mkdir -p public/uploads

EXPOSE 3000

# Health check — matches Render's healthCheckPath
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run the server; it runs migrations before listening
CMD ["node", "server.js"]
