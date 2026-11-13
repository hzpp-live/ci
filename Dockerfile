FROM node:26.13.1-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN npm install --global pnpm@10.33.0
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

FROM node:26.13.1-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN npm install --global pnpm@10.33.0

COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts

EXPOSE 3000

CMD ["pnpm", "start"]
