# State moves for resources gated on var.devenv_enabled (deployment_mode = "devenv").

moved {
  from = aws_iam_role.ec2_idle_stop
  to   = aws_iam_role.ec2_idle_stop[0]
}

moved {
  from = aws_iam_role_policy_attachment.ec2_idle_stop_basic
  to   = aws_iam_role_policy_attachment.ec2_idle_stop_basic[0]
}

moved {
  from = aws_iam_role_policy.ec2_idle_stop_policy
  to   = aws_iam_role_policy.ec2_idle_stop_policy[0]
}

moved {
  from = aws_cloudwatch_log_group.ec2_idle_stop
  to   = aws_cloudwatch_log_group.ec2_idle_stop[0]
}

moved {
  from = aws_lambda_function.ec2_idle_stop
  to   = aws_lambda_function.ec2_idle_stop[0]
}

moved {
  from = aws_cloudwatch_event_rule.ec2_idle_check
  to   = aws_cloudwatch_event_rule.ec2_idle_check[0]
}

moved {
  from = aws_cloudwatch_event_target.ec2_idle_check
  to   = aws_cloudwatch_event_target.ec2_idle_check[0]
}

moved {
  from = aws_lambda_permission.ec2_idle_check
  to   = aws_lambda_permission.ec2_idle_check[0]
}

moved {
  from = aws_cloudwatch_event_rule.ec2_eod_shutdown
  to   = aws_cloudwatch_event_rule.ec2_eod_shutdown[0]
}

moved {
  from = aws_cloudwatch_event_target.ec2_eod_shutdown
  to   = aws_cloudwatch_event_target.ec2_eod_shutdown[0]
}

moved {
  from = aws_lambda_permission.ec2_eod_shutdown
  to   = aws_lambda_permission.ec2_eod_shutdown[0]
}

moved {
  from = aws_cloudwatch_event_rule.ec2_hibernate_expiry
  to   = aws_cloudwatch_event_rule.ec2_hibernate_expiry[0]
}

moved {
  from = aws_cloudwatch_event_target.ec2_hibernate_expiry
  to   = aws_cloudwatch_event_target.ec2_hibernate_expiry[0]
}

moved {
  from = aws_lambda_permission.ec2_hibernate_expiry
  to   = aws_lambda_permission.ec2_hibernate_expiry[0]
}

moved {
  from = aws_ecs_cluster.otel
  to   = aws_ecs_cluster.otel[0]
}

moved {
  from = aws_security_group.otel_collector
  to   = aws_security_group.otel_collector[0]
}

moved {
  from = aws_security_group.otel_nlb
  to   = aws_security_group.otel_nlb[0]
}

moved {
  from = aws_lb.otel
  to   = aws_lb.otel[0]
}

moved {
  from = aws_lb_target_group.otel
  to   = aws_lb_target_group.otel[0]
}

moved {
  from = aws_lb_listener.otel
  to   = aws_lb_listener.otel[0]
}

moved {
  from = aws_iam_role.otel_task_exec
  to   = aws_iam_role.otel_task_exec[0]
}

moved {
  from = aws_iam_role_policy_attachment.otel_task_exec
  to   = aws_iam_role_policy_attachment.otel_task_exec[0]
}

moved {
  from = aws_iam_role.otel_task
  to   = aws_iam_role.otel_task[0]
}

moved {
  from = aws_iam_role_policy.otel_task_s3put
  to   = aws_iam_role_policy.otel_task_s3put[0]
}

moved {
  from = aws_cloudwatch_log_group.otel_collector
  to   = aws_cloudwatch_log_group.otel_collector[0]
}

moved {
  from = aws_ecs_task_definition.otel_collector
  to   = aws_ecs_task_definition.otel_collector[0]
}

moved {
  from = aws_ecs_service.otel_collector
  to   = aws_ecs_service.otel_collector[0]
}

moved {
  from = aws_appautoscaling_target.otel_collector
  to   = aws_appautoscaling_target.otel_collector[0]
}

moved {
  from = aws_appautoscaling_policy.otel_collector_cpu
  to   = aws_appautoscaling_policy.otel_collector_cpu[0]
}
