locals {

  oidc_trust = {
    for environment in ["release", "staging", "production"] : environment => jsonencode({
      Version = "2012-10-17", Statement = [{

        Effect = "Allow", Principal = {
          Federated = var.github_oidc_arn
        }, Action   = "sts:AssumeRoleWithWebIdentity",
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${environment}"
          }

        }


        }
      ]
      }
    )
  }


}

resource "aws_iam_role" "publisher" {

  name               = "${local.name}-publisher"
  assume_role_policy = local.oidc_trust.release

}

resource "aws_iam_role_policy" "publisher" {

  role = aws_iam_role.publisher.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"], Resource = aws_ecr_repository.app.arn
      }

    ]
    }
  )

}

resource "aws_iam_role" "deployer" {

  name               = "${local.name}-deployer"
  assume_role_policy = local.oidc_trust[var.environment]

}

resource "aws_iam_role_policy" "deployer" {

  role = aws_iam_role.deployer.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = [for service in aws_ecs_service.this : service.id]
      },
      {
        Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = local.task_family_arns
      },
      {
        Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "cloudwatch:GetMetricData"], Resource = "*", Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.region
          }

        }

      },
      {
        Effect = "Allow", Action = ["ecs:RunTask"], Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-migration:*", Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn }
        }
      },
      {
        Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task/${aws_ecs_cluster.this.name}/*"
      },
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"], Resource = local.release_repository_arn
      },
      {
        Effect = "Allow", Action = ["iam:PassRole"], Resource = concat([for role in aws_iam_role.execution : role.arn], [for role in aws_iam_role.task : role.arn]), Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }

        }

      }

    ]
    }
  )

}
