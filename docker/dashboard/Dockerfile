# CC-on-Bedrock Dashboard — ARM64 multi-stage build
# Uses Next.js standalone output for minimal image size

FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies first (layer cache)
COPY shared/nextjs-app/package.json shared/nextjs-app/package-lock.json ./
RUN npm ci --ignore-scripts

# Next.js NEXT_PUBLIC_* vars are inlined at build time, not runtime.
# Pass them in via --build-arg so they make it into the bundle.
ARG NEXT_PUBLIC_LOCAL_MODE_ENABLED=true
ENV NEXT_PUBLIC_LOCAL_MODE_ENABLED=$NEXT_PUBLIC_LOCAL_MODE_ENABLED

# Copy source and build
COPY shared/nextjs-app/ ./
RUN npm run build

# --- Production image ---
FROM node:20-slim AS runner
LABEL maintainer="cc-on-bedrock"
LABEL description="CC-on-Bedrock Dashboard (Next.js standalone)"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy standalone server + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy tools/cc-bedrock-local.sh so /api/install/cli can serve it at runtime (ADR-014)
COPY tools/cc-bedrock-local.sh ./public/tools/cc-bedrock-local.sh

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000

# Health check for ECS
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
