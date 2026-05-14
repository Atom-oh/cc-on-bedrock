output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "nlb_dns" {
  value = aws_lb.nlb.dns_name
}

output "routing_table_name" {
  value = aws_dynamodb_table.routing.name
}

output "routing_table_arn" {
  value = aws_dynamodb_table.routing.arn
}

output "nginx_config_lambda_arn" {
  value = aws_lambda_function.nginx_config.arn
}

output "user_data_bucket_name" {
  value = aws_s3_bucket.user_data.id
}

output "user_data_bucket_arn" {
  value = aws_s3_bucket.user_data.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.devenv.repository_url
}

output "nginx_ecr_repository_url" {
  value = aws_ecr_repository.nginx.repository_url
}

output "dlp_sg_open_id" {
  value = aws_security_group.dlp_open.id
}

output "dlp_sg_restricted_id" {
  value = aws_security_group.dlp_restricted.id
}

output "dlp_sg_locked_id" {
  value = aws_security_group.dlp_locked.id
}
