resource "aws_acm_certificate" "this" {

  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }


}

resource "aws_route53_record" "validation" {

  zone_id         = var.zone_id
  name            = one(aws_acm_certificate.this.domain_validation_options).resource_record_name
  type            = one(aws_acm_certificate.this.domain_validation_options).resource_record_type
  records         = [one(aws_acm_certificate.this.domain_validation_options).resource_record_value]
  ttl             = 60
  allow_overwrite = false

}

resource "aws_acm_certificate_validation" "this" {

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [aws_route53_record.validation.fqdn]

}

resource "aws_lb" "this" {

  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = true
  drop_invalid_header_fields = true

}

resource "aws_lb_target_group" "api" {

  name                 = local.name
  port                 = 5002
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30
  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }


}

resource "aws_lb_listener" "https" {

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }


}

resource "aws_lb_listener_rule" "private_routes" {

  listener_arn = aws_lb_listener.https.arn
  priority     = 1
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"message\":\"Not found\"}"
      status_code  = "404"
    }

  }

  condition {
    path_pattern {
      values = ["/metrics*", "/ready*", "/health*", "/api-docs*"]
    }

  }


}

resource "aws_route53_record" "api" {

  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }


}

resource "aws_wafv2_web_acl" "this" {

  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {

    }

  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = false
  }

  rule {
    name     = "common"
    priority = 1
    override_action {
      none {

      }

    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }

    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = false
    }

  }

  rule {
    name     = "ip-rate-limit"
    priority = 2
    action {
      block {

      }

    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }

    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate"
      sampled_requests_enabled   = false
    }

  }


}

resource "aws_wafv2_web_acl_association" "this" {

  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn

}
