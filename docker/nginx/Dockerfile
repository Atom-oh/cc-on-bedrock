# Nginx dynamic router for CC-on-Bedrock Enterprise
# Handles Host-header based routing to user containers
# Replaces ALB listener rules (100 rule limit) with unlimited routing
# CloudFront terminates TLS; Nginx listens on port 80 only

FROM nginx:1.27-alpine

# Install AWS CLI for S3 config sync
RUN apk add --no-cache \
    aws-cli \
    curl \
    bash

# Create directories
RUN mkdir -p /var/log/nginx

# Copy config template and reload script
COPY nginx.conf.template /etc/nginx/nginx.conf
COPY reload.sh /opt/reload.sh

# Make reload script executable
RUN chmod +x /opt/reload.sh

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:80/health || exit 1

# Expose port 80 (HTTP traffic including health checks)
EXPOSE 80

# Run reload script which starts nginx and polls S3 for config updates
CMD ["/opt/reload.sh"]
