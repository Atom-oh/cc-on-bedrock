FROM ghcr.io/berriai/litellm:main

LABEL maintainer="cc-on-bedrock"
LABEL description="CC-on-Bedrock LiteLLM Proxy with Bedrock integration"

USER root

# Install envsubst (gettext) and jq for config templating + secret parsing
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends gettext-base jq curl unzip && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 for Secrets Manager access
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip; \
    else \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip; \
    fi && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Copy config and entrypoint
COPY litellm-config.yaml /app/litellm-config.yaml
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:4000/health/liveness || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
