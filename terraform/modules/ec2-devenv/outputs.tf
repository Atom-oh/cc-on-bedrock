output "launch_template_id" {
  value = aws_launch_template.devenv.id
}

output "launch_template_name" {
  value = aws_launch_template.devenv.name
}

output "instance_profile_arn" {
  value = aws_iam_instance_profile.devenv.arn
}

output "instance_profile_name" {
  value = aws_iam_instance_profile.devenv.name
}

output "sg_open_id" {
  value = aws_security_group.open.id
}

output "sg_restricted_id" {
  value = aws_security_group.restricted.id
}

output "sg_locked_id" {
  value = aws_security_group.locked.id
}

output "instance_table_name" {
  value = aws_dynamodb_table.user_instances.name
}
