# Custom OTel collector image for cc-on-bedrock productivity monitoring (Phase 1).
#
# The AWS ADOT distro lacks the `awss3` exporter (confirmed at runtime: v0.48.0 valid
# exporters do not include awss3), so we base on the upstream OpenTelemetry Collector
# *contrib* distro, which bundles awss3exporter + cumulativetodelta. The config is baked
# in at the default path so no command/AOT_CONFIG_CONTENT plumbing is needed; bucket and
# region are still supplied via ${env:...} at task launch.
#
# Pushed to private ECR and pulled in-VPC via the existing ECR endpoints (no public
# registry dependency at runtime — financial-compliance friendly).
FROM otel/opentelemetry-collector-contrib:latest

COPY config.yaml /etc/otelcol-contrib/config.yaml
