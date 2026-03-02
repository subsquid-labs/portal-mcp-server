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

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

CMD ["node", "dist/index.js"]