FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist

ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=3001
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "dist/index.js"]
