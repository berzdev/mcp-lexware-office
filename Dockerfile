FROM node:22-alpine AS builder
WORKDIR /src
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS release
WORKDIR /app
COPY --from=builder /src/build ./build
COPY --from=builder /src/package.json .
COPY --from=builder /src/package-lock.json* .
ENV NODE_ENV=production
RUN npm ci --ignore-scripts --omit=dev && \
    npm install -g supergateway
EXPOSE 8000
CMD ["sh", "-c", "while true; do supergateway --port 8000 --stdio 'node /app/build/index.js'; sleep 1; done"]
