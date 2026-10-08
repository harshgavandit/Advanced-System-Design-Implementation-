mock_provider "aws" {

  override_during = apply
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:targetgroup/scaling-staging/aaaaaaaaaaaaaaaa" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:listener/app/scaling-staging/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:111111111111:task-definition/scaling-staging-api:1" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:111111111111:cluster/scaling-staging", id = "arn:aws:ecs:ap-south-1:111111111111:cluster/scaling-staging" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:111111111111:loadbalancer/app/scaling-staging/aaaaaaaaaaaaaaaa" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:ap-south-1:111111111111:regional/webacl/synthetic/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
  }
  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:ap-south-1:111111111111:certificate/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-south-1:111111111111:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/synthetic" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-south-1:111111111111:synthetic" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-south-1:111111111111:log-group:/ecs/scaling-staging" }
  }
  mock_resource "aws_acm_certificate" {

    defaults = {
      arn = "arn:aws:acm:ap-south-1:111111111111:certificate/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
      domain_validation_options = [{
        domain_name = "staging.example.invalid", resource_record_name = "_verify.staging.example.invalid", resource_record_type = "CNAME", resource_record_value = "_synthetic.acm-validations.aws"
        }
      ]
    }


  }


}

mock_provider "mongodbatlas" {
  override_during = apply
}

variables {

  cloud_enabled      = true
  environment        = "staging"
  region             = "ap-south-1"
  account_id         = "111111111111"
  availability_zones = ["ap-south-1a", "ap-south-1b"]
  domain             = "staging.example.invalid"
  zone_id            = "ZTEST"
  github_repository  = "synthetic/scaling-lab"
  github_oidc_arn    = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
  incident_owner     = "synthetic-test"
  budget_email       = "test@example.invalid"
  monthly_budget_usd = 300
  image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  atlas_project_id   = "aaaaaaaaaaaaaaaaaaaaaaaa"
  atlas_region       = "AP_SOUTH_1"
  redis_auth_token   = "synthetic-test-only-placeholder"
  atlas_passwords = {
    application = "synthetic-test-only", migration = "synthetic-test-only", monitoring = "synthetic-test-only"
  }

  secret_arns = {

    MONGO_URI           = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:mock-mongo"
    JWT_ACCESS_SECRET   = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:mock-access"
    JWT_REFRESH_SECRET  = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:mock-refresh"
    REDIS_URL           = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:mock-redis"
    MIGRATION_MONGO_URI = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:mock-migration"

  }


}

run "security_and_scaling" {

  # Both providers are mocked; network-isolated execution cannot provision cloud resources.
  command = apply
  assert {
    condition     = length(aws_subnet.private) == 2 && alltrue([for subnet in aws_subnet.private : !subnet.map_public_ip_on_launch])
    error_message = "Tasks must remain private across distinct AZs."
  }

  assert {
    condition     = alltrue([for service in aws_ecs_service.this : !service.network_configuration[0].assign_public_ip && service.deployment_circuit_breaker[0].rollback && service.deployment_minimum_healthy_percent == 100])
    error_message = "Private tasks, healthy capacity and circuit-breaker rollback are mandatory."
  }

  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds == 60 && aws_sqs_queue.dlq.message_retention_seconds > aws_sqs_queue.jobs.message_retention_seconds
    error_message = "Queue visibility and DLQ retention contracts must hold."
  }

  assert {
    condition     = aws_elasticache_replication_group.this.transit_encryption_enabled && aws_elasticache_replication_group.this.multi_az_enabled && mongodbatlas_advanced_cluster.this.pit_enabled
    error_message = "Data encryption, cache failover and PIT recovery must be configured."
  }

  assert {
    condition     = jsondecode(aws_iam_role.deployer.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:synthetic/scaling-lab:environment:staging"
    error_message = "OIDC trust must match the exact repository and environment."
  }

  assert {
    condition     = aws_appautoscaling_policy.api_cpu.target_tracking_scaling_policy_configuration[0].target_value == 60 && aws_appautoscaling_target.this["api"].max_capacity == 4
    error_message = "Scaling must retain the measured-budget cap."
  }

  assert {
    condition     = alltrue([for task in aws_ecs_task_definition.this : jsondecode(task.container_definitions)[0].readonlyRootFilesystem && jsondecode(task.container_definitions)[0].user == "1000:1000"])
    error_message = "All application entrypoints must be non-root and read-only."
  }

  assert {
    condition     = toset([for notice in aws_budgets_budget.this.notification : notice.threshold if notice.notification_type == "ACTUAL"]) == toset([50, 80, 100])
    error_message = "Actual spend must notify at 50, 80 and 100 percent of the approved budget."
  }


}

run "disabled_placeholders_cannot_plan" {

  command = plan
  variables {
    cloud_enabled = false
  }

  expect_failures = [terraform_data.configuration_guard]

}

run "invalid_digest_is_rejected" {

  command = plan
  variables {
    image_digest = "latest"
  }

  expect_failures = [var.image_digest]

}

run "invalid_replica_budget_is_rejected" {

  command = plan
  variables {
    api_max = 100
  }

  expect_failures = [var.api_max]

}

run "rollout_pool_budget_is_rejected" {
  command = plan
  variables { mongo_connection_budget = 50 }
  expect_failures = [terraform_data.configuration_guard]
}
