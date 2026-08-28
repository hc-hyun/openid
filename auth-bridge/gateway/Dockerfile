FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json server.mjs ./

USER node
EXPOSE 30001

CMD ["node", "server.mjs"]
