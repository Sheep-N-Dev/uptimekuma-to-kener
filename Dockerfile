FROM node:22.6-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install pm2 -g
RUN npm install

RUN mkdir -p /app/librarie

COPY --chown=node:node index.js ./
COPY --chown=node:node ./libraries/utils.js .librarie
COPY --chown=node:node logs_text.json ./

CMD ["pm2-runtime", "--machine-name", "uptimekuma-to-kener", "index.js"]