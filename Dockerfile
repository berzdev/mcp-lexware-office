FROM node:22-alpine AS builder
RUN apk add --no-cache git
RUN git clone --depth=1 https://github.com/JannikWempe/mcp-lexware-office.git /src
WORKDIR /src
RUN npm install && npm run build

FROM node:22-alpine AS release
WORKDIR /app
COPY --from=builder /src/build ./build
COPY --from=builder /src/package.json .
COPY --from=builder /src/package-lock.json .
ENV NODE_ENV=production
RUN npm ci --ignore-scripts --omit-dev && \
    npm install -g supergateway
EXPOSE 8000
CMD ["supergateway", "--stdio", "node /app/build/index.js", "--port", "8000", "--sse", "/sse"]
