FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
