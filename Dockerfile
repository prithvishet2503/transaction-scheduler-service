# Transaction Scheduler Service
# Hackathon demo image: builds the TypeScript service and runs it with Node 22.

FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist

# Non-root user
RUN addgroup -S scheduler && adduser -S scheduler -G scheduler
USER scheduler:scheduler

EXPOSE 3000
CMD ["node", "dist/server.js"]
