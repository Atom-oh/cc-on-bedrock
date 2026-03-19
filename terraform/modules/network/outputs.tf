output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = [aws_subnet.public_a.id, aws_subnet.public_c.id]
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_c.id]
}

output "isolated_subnet_ids" {
  value = [aws_subnet.isolated_a.id, aws_subnet.isolated_c.id]
}

output "hosted_zone_id" {
  value = aws_route53_zone.this.zone_id
}

output "hosted_zone_name" {
  value = aws_route53_zone.this.name
}
