FROM oven/bun:1.3-alpine
WORKDIR /app

COPY package.json ./
COPY index.ts ./

# No external deps — index.ts uses only Bun's built-ins (WebSocket, fetch, Bun.serve)
# but we still run install for any future deps + to populate node_modules.
RUN bun install

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "index.ts"]
