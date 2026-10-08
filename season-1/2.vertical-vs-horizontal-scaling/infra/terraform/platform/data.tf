resource "aws_kms_key" "data" {

  description             = "${local.name} queues, cache and restricted telemetry"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }, Action = "kms:*", Resource = "*" },
    { Sid = "RestrictedLogs", Effect = "Allow", Principal = { Service = "logs.${var.region}.amazonaws.com" }, Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"], Resource = "*", Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/ecs/${local.name}*" } } }
  ] })
  lifecycle {
    prevent_destroy = true
  }


}

resource "aws_sqs_queue" "dlq" {

  name                      = "${local.name}-ingestion-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

}

resource "aws_sqs_queue" "jobs" {

  name                       = "${local.name}-ingestion"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 10
  kms_master_key_id          = aws_kms_key.data.arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5
    }
  )

}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {

  queue_url = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.jobs.arn]
    }
  )

}

resource "aws_elasticache_subnet_group" "this" {

  name       = local.name
  subnet_ids = aws_subnet.private[*].id

}

resource "aws_elasticache_replication_group" "this" {

  replication_group_id       = local.name
  description                = "Disposable authenticated TLS catalog cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = var.redis_auth_token
  kms_key_id                 = aws_kms_key.data.arn
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.dependencies.id]

}

resource "mongodbatlas_advanced_cluster" "this" {

  project_id                     = var.atlas_project_id
  name                           = local.name
  cluster_type                   = "REPLICASET"
  backup_enabled                 = true
  pit_enabled                    = true
  retain_backups_enabled         = true
  termination_protection_enabled = true
  replication_specs = [{
    region_configs = [{

      provider_name = "AWS"
      region_name   = var.atlas_region
      priority      = 7
      electable_specs = {
        instance_size = "M10", node_count = 3
      }


      }
    ]
    }
  ]
  lifecycle {
    prevent_destroy = true
  }


}

resource "mongodbatlas_cloud_backup_schedule" "this" {

  project_id               = var.atlas_project_id
  cluster_name             = mongodbatlas_advanced_cluster.this.name
  reference_hour_of_day    = 3
  reference_minute_of_hour = 0
  restore_window_days      = 7
  policy_item_hourly {
    frequency_interval = 1
    retention_unit     = "days"
    retention_value    = 7
  }

  policy_item_daily {
    frequency_interval = 1
    retention_unit     = "days"
    retention_value    = 30
  }


}

resource "mongodbatlas_privatelink_endpoint" "this" {

  project_id    = var.atlas_project_id
  provider_name = "AWS"
  region        = var.region

}

resource "aws_vpc_endpoint" "atlas" {

  vpc_id             = aws_vpc.this.id
  service_name       = mongodbatlas_privatelink_endpoint.this.endpoint_service_name
  vpc_endpoint_type  = "Interface"
  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.dependencies.id]

}

resource "mongodbatlas_privatelink_endpoint_service" "this" {

  project_id          = var.atlas_project_id
  private_link_id     = mongodbatlas_privatelink_endpoint.this.private_link_id
  endpoint_service_id = aws_vpc_endpoint.atlas.id
  provider_name       = "AWS"

}

resource "mongodbatlas_database_user" "this" {

  for_each           = toset(["application", "migration", "monitoring"])
  project_id         = var.atlas_project_id
  username           = "${local.name}-${each.key}"
  password           = var.atlas_passwords[each.key]
  auth_database_name = "admin"
  roles {

    role_name     = each.key == "monitoring" ? "clusterMonitor" : each.key == "migration" ? "dbOwner" : "readWrite"
    database_name = each.key == "monitoring" ? "admin" : local.database

  }

  scopes {
    name = mongodbatlas_advanced_cluster.this.name
    type = "CLUSTER"
  }


}
