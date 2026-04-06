FROM node:20-bookworm-slim

# better-sqlite3 butuh build tools native
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
