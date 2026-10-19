FROM node:22-bookworm-slim

# Must match the scrcpy-server binary; the server refuses other client versions.
ARG SCRCPY_VERSION=3.3.1
# Set to true to include ffmpeg for demo devices (test-pattern streams).
ARG WITH_FFMPEG=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends adb ca-certificates curl \
 && if [ "$WITH_FFMPEG" = "true" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/scrcpy \
 && curl -fsSL -o /opt/scrcpy/scrcpy-server \
    "https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY config ./config

ENV NODE_ENV=production \
    SCRCPY_SERVER_PATH=/opt/scrcpy/scrcpy-server \
    SCRCPY_VERSION=${SCRCPY_VERSION} \
    DATA_DIR=/data
VOLUME ["/data", "/root/.android"]
EXPOSE 8080
CMD ["node", "server/index.js"]
