# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app

# Install Python + mcp-proxy into a venv
RUN apk add --no-cache python3 py3-uv && \
    uv venv /opt/venv && \
    uv pip install --python /opt/venv/bin/python mcp-proxy

ENV PATH="/opt/venv/bin:$PATH"

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 8080

CMD ["mcp-proxy", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--allow-origin", "*", \
     "--pass-environment", \
     "--", "node", "dist/index.js"]
