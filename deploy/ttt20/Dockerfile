FROM node:24-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/server.js server/game-rules.js server/room-store.js ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
