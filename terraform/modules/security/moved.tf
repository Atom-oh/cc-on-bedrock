# State moves for resources gated on var.devenv_enabled (deployment_mode = "devenv").

moved {
  from = aws_acm_certificate.devenv
  to   = aws_acm_certificate.devenv[0]
}

moved {
  from = aws_acm_certificate_validation.devenv
  to   = aws_acm_certificate_validation.devenv[0]
}

moved {
  from = aws_iam_role_policy.dashboard_ec2_devenv
  to   = aws_iam_role_policy.dashboard_ec2_devenv[0]
}

moved {
  from = aws_iam_role_policy.dashboard_ecs
  to   = aws_iam_role_policy.dashboard_ecs[0]
}
