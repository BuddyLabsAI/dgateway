FROM oven/bun:1.3 AS console-build
WORKDIR /app
ARG SKIP_CONSOLE=false
COPY src/ ./src/
RUN mkdir -p /console && if [ "$SKIP_CONSOLE" != "true" ] && [ -f src/modules/gateway/apps/console-web/package.json ]; then cd src/modules/gateway/apps/console-web && bun install --frozen-lockfile && bun run build && cp -a dist/. /console/; fi

FROM oven/bun:1.3 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.3 AS runtime
LABEL org.opencontainers.image.source="https://github.com/BuddyLabsAI/dgateway" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="dgateway" \
      org.opencontainers.image.description="Unified self-hosted API gateway for decision models"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data CONSOLE_DIR=/app/console DGATEWAY_HOST=0.0.0.0 DGATEWAY_PORT=8790
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src/modules/gateway/libs ./src/modules/gateway/libs
COPY --chown=bun:bun src/modules/gateway/api ./src/modules/gateway/api
COPY --chown=bun:bun src/modules/gateway/apps/gateway-daemon ./src/modules/gateway/apps/gateway-daemon
COPY --from=console-build --chown=bun:bun /console ./console
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD bun -e "fetch('http://127.0.0.1:'+(process.env.DGATEWAY_PORT || process.env.PORT || '8790')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "src/modules/gateway/apps/gateway-daemon/index.ts"]
