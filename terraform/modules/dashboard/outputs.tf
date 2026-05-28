output "dashboard_url" {
  value = "https://${var.dashboard_subdomain}.${var.domain_name}"
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
