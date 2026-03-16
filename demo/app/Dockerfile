# ABOUTME: Multi-stage Dockerfile for the demo app. Builds TypeScript in a build stage,
# ABOUTME: then copies only production artifacts to a slim runtime image.

# --- Build stage ---
FROM node:22-alpine AS build

WORKDIR /app

# Install all dependencies (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript from build stage
COPY --from=build /app/dist/ ./dist/

# Copy static assets (spider image for the fun page)
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "dist/index.js"]
