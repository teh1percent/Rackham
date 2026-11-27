FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/teh1percent/Rackham"
LABEL org.opencontainers.image.description="Setup wizard for self-hosted media stacks"
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV PORT=8099
EXPOSE 8099
CMD ["node", "server.js"]
