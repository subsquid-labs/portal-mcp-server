FROM node:24-alpine AS build

WORKDIR /app

# Enable pnpm via corepack (Node 24 has it built-in)
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@latest --activate \
  && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:24-alpine

RUN apk add --no-cache curl

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/http.js"]