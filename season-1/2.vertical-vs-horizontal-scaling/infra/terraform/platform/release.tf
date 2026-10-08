variable "release_repository_url" {
  type    = string
  default = ""
}

variable "release_repository_arn" {
  type    = string
  default = ""
}

locals {
  # Production pulls the same signed digest from staging's shared release repository.
  release_repository_url = var.release_repository_url != "" ? var.release_repository_url : aws_ecr_repository.app.repository_url
  release_repository_arn = var.release_repository_arn != "" ? var.release_repository_arn : aws_ecr_repository.app.arn
  task_family_arns       = [for role in local.roles : "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-${role}:*"]
}

resource "terraform_data" "release_guard" {
  lifecycle {
    precondition {
      condition     = (var.release_repository_url == "") == (var.release_repository_arn == "")
      error_message = "A shared repository requires both its URL and ARN."
    }
    precondition {
      condition     = var.environment != "production" || (startswith(var.release_repository_url, "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/") && startswith(var.release_repository_arn, "arn:aws:ecr:${var.region}:${var.account_id}:repository/"))
      error_message = "Production must promote from an explicitly configured same-account release repository."
    }
  }
}
