FROM node:24-alpine
ARG VERSION=dev
COPY monitor.mjs /app/monitor.mjs
USER 568:568
EXPOSE 8080
ENV TZ=Europe/London CHECK_TIME=06:00 LISTEN_PORT=8080 NODE_ENV=production APP_VERSION=$VERSION
CMD ["node", "/app/monitor.mjs"]

LABEL org.opencontainers.image.source=https://github.com/jasoncabot/library-monitor
