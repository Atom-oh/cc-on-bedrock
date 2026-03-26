output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "efs_id" {
  value = aws_efs_file_system.this.id
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "alb_dns" {
  value = aws_lb.this.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.devenv.repository_url
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

output "user_data_bucket_name" {
  value = aws_s3_bucket.user_data.id
}

output "user_data_bucket_arn" {
  value = aws_s3_bucket.user_data.arn
}

output "user_volumes_table_name" {
  value = aws_dynamodb_table.user_volumes.name
}

output "user_volumes_table_arn" {
  value = aws_dynamodb_table.user_volumes.arn
}
