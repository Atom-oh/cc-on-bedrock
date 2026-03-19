output "internal_alb_dns" {
  value = aws_lb.this.dns_name
}

output "internal_alb_arn" {
  value = aws_lb.this.arn
}

output "rds_endpoint" {
  value = aws_db_instance.this.address
}

output "ecr_repository_url" {
  value = aws_ecr_repository.litellm.repository_url
}

output "rds_credentials_secret_arn" {
  value = aws_secretsmanager_secret.rds_credentials.arn
}
