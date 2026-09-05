FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
