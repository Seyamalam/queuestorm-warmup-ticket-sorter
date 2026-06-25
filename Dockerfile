FROM oven/bun:1.3.13-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

EXPOSE 3000

CMD ["bun", "run", "start"]
