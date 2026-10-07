FROM node:20-alpine
RUN apk add --no-cache python3 make g++ \
 && ln -sf python3 /usr/bin/python
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
