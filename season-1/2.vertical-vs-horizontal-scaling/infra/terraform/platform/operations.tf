resource "aws_prometheus_workspace" "this" {
  alias = local.name
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_email

}

resource "aws_cloudwatch_metric_alarm" "queue_age" {

  alarm_name  = "${local.name}-oldest-job"
  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions = {
    QueueName = aws_sqs_queue.jobs.name
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 30
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

}

resource "aws_cloudwatch_metric_alarm" "dlq" {

  alarm_name  = "${local.name}-dead-letter"
  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

}

resource "aws_budgets_budget" "this" {

  name         = local.name
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Environment$${var.environment}"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }

  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }


}

output "release_target" {

  value = {
    enabled = false, environment = var.environment, accountId = var.account_id, region = var.region, repository = local.release_repository_url, cluster = aws_ecs_cluster.this.name, services = {
      for role, service in aws_ecs_service.this : role => service.name
    }, migrationTask = aws_ecs_task_definition.this["migration"].arn, subnets = aws_subnet.private[*].id, securityGroup = aws_security_group.tasks.id, url = "https://${var.domain}", loadBalancerDimension = aws_lb.this.arn_suffix, baselineP95Ms = 0
  }


}
