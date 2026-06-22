output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "nlb_dns" {
  value = aws_lb.nlb.dns_name
}

output "routing_table_name" {
  value = aws_dynamodb_table.routing.name
}

output "nginx_config_bucket_name" {
  value = aws_s3_bucket.user_data.id
}

output "nginx_ecr_repository_url" {
  value = aws_ecr_repository.nginx.repository_url
}

output "user_data_bucket_name" {
  value = aws_s3_bucket.user_data.id
}

output "user_data_bucket_arn" {
  value = aws_s3_bucket.user_data.arn
}

output "nginx_security_group_id" {
  value = aws_security_group.nginx.id
}

output "otel_collector_endpoint" {
  value = "http://${aws_lb.otel_collector.dns_name}:4318"
}
