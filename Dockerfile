FROM node:22-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/
RUN mkdir -p backend/data && cd backend && npm ci --no-audit --no-fund
COPY backend/ backend/
COPY frontend/ frontend/
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production
ENV DB_PATH=/app/backend/data/database.json
EXPOSE 3001
CMD ["node", "backend/server.js"]
