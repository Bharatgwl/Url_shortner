FROM node:26.13.1-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY routes ./routes
COPY services ./services
COPY repositories ./repositories
COPY queues ./queues
COPY utils ./utils
COPY workers ./workers
COPY creationServer.js redirectServer.js ./
COPY docker/init-queue.js ./docker/init-queue.js

USER node

CMD ["node", "redirectServer.js"]
