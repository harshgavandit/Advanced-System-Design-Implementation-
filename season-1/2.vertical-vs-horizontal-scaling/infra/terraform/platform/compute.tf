resource "aws_ecr_repository" "app" {

  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }

  force_delete = false

}

resource "aws_ecs_cluster" "this" {

  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }


}

resource "aws_cloudwatch_log_group" "app" {

  name              = "/ecs/${local.name}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn

}

locals {

  task_trust = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
        }, Action = "sts:AssumeRole", Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
          }, ArnLike = {
          "aws:SourceArn" = "arn:aws:ecs:${var.region}:${var.account_id}:*"
        }

      }

      }
    ]
    }
  )
  role_secrets = {
    api = ["MONGO_URI", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "REDIS_URL"], worker = ["MONGO_URI", "REDIS_URL"], outbox = ["MONGO_URI"], migration = ["MIGRATION_MONGO_URI"]
  }

  commands = {
    api = ["node", "dist/container.js"], worker = ["node", "dist/worker.js"], outbox = ["node", "dist/outbox.js"], migration = ["node", "dist/migrate.js"]
  }


}

resource "aws_iam_role" "execution" {

  for_each           = local.roles
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = local.task_trust

}

resource "aws_iam_role_policy" "execution" {

  for_each = local.roles
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = local.release_repository_arn
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
      {
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for key in local.role_secrets[each.key] : var.secret_arns[key]]
      },
      {
        Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.data.arn, Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:SecretARN" = [for key in local.role_secrets[each.key] : var.secret_arns[key]] }
        }
      }

    ]
    }
  )

}

resource "aws_iam_role" "task" {

  for_each           = local.roles
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = local.task_trust

}

resource "aws_iam_role_policy" "task" {

  for_each = toset(["api", "worker", "outbox"])
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = concat([
      {
        Effect = "Allow", Action = ["sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.jobs.arn, aws_sqs_queue.dlq.arn]
      },
      {
        Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.data.arn
      },
      {
        Effect = "Allow", Action = ["aps:RemoteWrite"], Resource = aws_prometheus_workspace.this.arn
      },
      {
        Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*"
      }

      ], each.key == "worker" ? [{
        Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource = aws_sqs_queue.jobs.arn
      }
      ] : each.key == "outbox" ? [{
        Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.jobs.arn
      }
      ] : [{
        Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage"], Resource = aws_sqs_queue.dlq.arn
      }
    ])
    }
  )

}

locals {

  collector_config = yamlencode({

    receivers = {

      otlp = {
        protocols = {
          http = {
            endpoint = "127.0.0.1:4318"
          }

        }

      }

      prometheus = {
        config = {
          scrape_configs = [{
            job_name = "catalog", scrape_interval = "15s", static_configs = [{
              targets = ["127.0.0.1:5002"]
              }
            ]
            }
          ]
        }

      }


    }

    processors = {

      memory_limiter = {
        check_interval = "1s", limit_mib = 192, spike_limit_mib = 32
      }

      batch = {
        timeout = "2s", send_batch_size = 256
      }


    }

    extensions = {
      sigv4auth = {
        region = var.region, service = "aps"
      }

    }

    exporters = {

      prometheusremotewrite = {
        endpoint = "${aws_prometheus_workspace.this.prometheus_endpoint}api/v1/remote_write", auth = {
          authenticator = "sigv4auth"
        }

      }

      awsxray = {
        region = var.region
      }


    }

    service = {

      extensions = ["sigv4auth"]
      pipelines = {

        metrics = {
          receivers = ["prometheus"], processors = ["memory_limiter", "batch"], exporters = ["prometheusremotewrite"]
        }

        traces = {
          receivers = ["otlp"], processors = ["memory_limiter", "batch"], exporters = ["awsxray"]
        }


      }


    }


    }
  )

}

resource "aws_ecs_task_definition" "this" {

  for_each                 = local.roles
  family                   = "${local.name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.key == "api" ? "1024" : "512"
  memory                   = each.key == "api" ? "2048" : "1024"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  container_definitions = jsonencode(concat([{

    name = "app", image = "${local.release_repository_url}@${var.image_digest}", essential = true,
    user = "1000:1000", readonlyRootFilesystem = true, command = local.commands[each.key],
    cpu  = each.key == "api" ? 896 : 384, memory = each.key == "api" ? 1536 : 768,
    stopTimeout = 30, linuxParameters = {
      initProcessEnabled = true, capabilities = {
        drop = ["ALL"]
      }

    },
    portMappings = each.key == "migration" ? [] : [{
      containerPort = 5002, protocol = "tcp"
      }
    ],
    healthCheck = each.key == "migration" ? null : {
      command = ["CMD", "node", "-e", "fetch('http://127.0.0.1:5002/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval = 10, timeout = 3, retries = 3, startPeriod = 30
    },
    secrets = [for key in local.role_secrets[each.key] : {
      name = key == "MIGRATION_MONGO_URI" ? "MONGO_URI" : key, valueFrom = var.secret_arns[key]
      }
    ],
    environment = [for name, value in {

      NODE_ENV             = "production", SERVICE_ROLE = each.key,
      PORT                 = "5002", MONGO_AUTO_INDEX = "false", MONGO_POOL_MAX = each.key == "api" ? "10" : each.key == "worker" ? "3" : each.key == "migration" ? "5" : "2",
      JWT_ISSUER           = "scaling-api", JWT_AUDIENCE = "scaling-clients", JWT_ACCESS_EXPIRES_IN = "15m",
      SQS_REGION           = var.region, SQS_QUEUE_URL = aws_sqs_queue.jobs.url, SQS_DLQ_URL = aws_sqs_queue.dlq.url,
      PUBLIC_CATALOG_CACHE = "true", TRACING_ENABLED = each.key == "migration" ? "false" : "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces", DEPLOYMENT_ENVIRONMENT = var.environment,
      OTEL_SERVICE_NAME    = each.key == "api" ? "catalog-api" : each.key == "worker" ? "catalog-worker" : "outbox-relay",
      NODE_OPTIONS         = each.key == "migration" ? "" : "--import=/app/dist/tracing.js",
      MIGRATION_TARGET_DB  = local.database, MIGRATION_CONFIRM = local.database

      }
      : {
        name = name, value = value
      }
    ],
    logConfiguration = {
      logDriver = "awslogs", options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key
      }

    }


    }
    ], each.key == "migration" ? [] : [{

      name                   = "collector", image = "otel/opentelemetry-collector-contrib@sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6", essential = true,
      readonlyRootFilesystem = true, cpu = 128, memory = 256,
      command                = ["--config=env:CLOUD_OTEL_CONFIG"],
      environment = [{
        name = "CLOUD_OTEL_CONFIG", value = local.collector_config
        }, {
        name = "AWS_REGION", value = var.region
        }
      ],
      logConfiguration = {
        logDriver = "awslogs", options = {
          "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "collector-${each.key}"
        }

      }


    }
  ]))
  depends_on = [terraform_data.configuration_guard, terraform_data.release_guard]

}

resource "aws_ecs_service" "this" {

  for_each                           = toset(["api", "worker", "outbox"])
  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.this[each.key].arn
  desired_count                      = each.key == "api" ? 2 : 1
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = each.key == "api" ? 60 : null
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {

    for_each = each.key == "api" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "app"
      container_port   = 5002
    }


  }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [aws_lb_listener.https, aws_iam_role_policy.execution, aws_iam_role_policy.task]

}
