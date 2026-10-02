FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ponytail: zero runtime deps, so no npm install step; add `npm ci --omit=dev` if deps appear
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1
CMD ["node", "src/server.js"]
