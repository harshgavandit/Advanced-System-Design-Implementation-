variable "cloud_enabled" {
  type    = bool
  default = false

}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Only isolated staging/production environments are supported."
  }


}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Exactly two distinct AZs are required."
  }


}

variable "domain" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "github_repository" {
  type = string
}

variable "github_oidc_arn" {
  type = string
}

variable "incident_owner" {
  type = string
}

variable "budget_email" {
  type = string
}

variable "monthly_budget_usd" {
  type = number
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "An explicit positive AWS budget is mandatory."
  }


}

variable "image_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Use an immutable, tested ECR digest."
  }


}

variable "api_max" {
  type    = number
  default = 4
  validation {
    condition     = var.api_max >= 2 && var.api_max <= 8
    error_message = "API maximum must fit the bounded initial DB/cost budget (2..8)."
  }


}

variable "worker_max" {
  type    = number
  default = 2
  validation {
    condition     = var.worker_max >= 1 && var.worker_max <= 4
    error_message = "Workers must be bounded to 1..4."
  }


}

variable "requests_per_target_per_minute" {
  type    = number
  default = 6000

}

variable "secret_arns" {
  type = map(string)
  validation {
    condition     = alltrue([for key in ["MONGO_URI", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "REDIS_URL", "MIGRATION_MONGO_URI"] : contains(keys(var.secret_arns), key)])
    error_message = "Provide explicit secret ARNs, never secret values in task definitions."
  }


}

variable "redis_auth_token" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.redis_auth_token) >= 16
    error_message = "Redis authentication requires a secret supplied out of band. Encrypted state remains sensitive."
  }


}

variable "atlas_project_id" {
  type = string
}

variable "atlas_region" {
  type = string
}

variable "atlas_passwords" {
  type      = map(string)
  sensitive = true

}

locals {
  # Per-server conservative budget includes rollout overlap and monitoring sockets.

  name     = "scaling-${var.environment}"
  roles    = toset(["api", "worker", "outbox", "migration"])
  database = "catalog_${var.environment}"

}

variable "mongo_connection_budget" {
  type    = number
  default = 250
  validation {
    condition     = var.mongo_connection_budget > 0
    error_message = "The database connection budget must be explicit and positive."
  }
}

resource "terraform_data" "configuration_guard" {

  lifecycle {

    precondition {

      condition     = var.cloud_enabled && var.account_id != "000000000000" && !strcontains(var.domain, "PLACEHOLDER") && !strcontains(var.github_repository, "PLACEHOLDER") && !strcontains(var.incident_owner, "PLACEHOLDER")
      error_message = "Cloud apply is disabled. Configure the approved account, owners and real non-secret targets before enabling it."

    }

    precondition {

      condition     = (2 * var.api_max * 10 + 2 * var.worker_max * 3 + 2 * 2 + 2 * 5 + (2 * var.api_max + 2 * var.worker_max + 3) * 2) <= var.mongo_connection_budget
      error_message = "Rollout-overlap pools exceed the configured per-server Mongo connection budget. Re-size before increasing replicas."

    }


  }


}
