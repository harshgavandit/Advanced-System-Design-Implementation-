resource "aws_iam_role" "grafana" {
  name               = "${local.name}-grafana"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "grafana.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "grafana" {
  role = aws_iam_role.grafana.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["aps:QueryMetrics", "aps:GetSeries", "aps:GetLabels", "aps:GetMetricMetadata"], Resource = aws_prometheus_workspace.this.arn },
    { Effect = "Allow", Action = ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "xray:BatchGetTraces", "xray:GetTraceSummaries", "xray:GetServiceGraph"], Resource = "*" },
    { Effect = "Allow", Action = ["logs:StartQuery", "logs:StopQuery", "logs:GetQueryResults", "logs:GetLogEvents"], Resource = "${aws_cloudwatch_log_group.app.arn}:*" }
  ] })
}
resource "aws_grafana_workspace" "this" {
  name                      = local.name
  account_access_type       = "CURRENT_ACCOUNT"
  authentication_providers  = ["AWS_SSO"]
  permission_type           = "CUSTOMER_MANAGED"
  role_arn                  = aws_iam_role.grafana.arn
  data_sources              = ["PROMETHEUS", "CLOUDWATCH", "XRAY"]
  notification_destinations = ["SNS"]
}
output "grafana_endpoint" { value = aws_grafana_workspace.this.endpoint }
