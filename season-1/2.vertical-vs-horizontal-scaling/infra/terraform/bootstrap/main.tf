terraform {

  required_version = "= 1.16.5"
  required_providers {
    aws = {
      source = "hashicorp/aws", version = "= 6.67.0"
    }

  }


}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "state_bucket" {
  type = string
}

variable "cloud_enabled" {
  type    = bool
  default = false
}

resource "terraform_data" "configuration_guard" {
  lifecycle {
    precondition {
      condition     = var.cloud_enabled && can(regex("^[0-9]{12}$", var.account_id)) && var.account_id != "000000000000" && !strcontains(var.state_bucket, "PLACEHOLDER")
      error_message = "Bootstrap is disabled until the approved real account and state bucket are configured."
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}

resource "aws_kms_key" "state" {
  depends_on = [terraform_data.configuration_guard]

  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }


}

resource "aws_s3_bucket" "state" {
  depends_on = [terraform_data.configuration_guard]

  bucket        = var.state_bucket
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }


}

resource "aws_s3_bucket_versioning" "state" {

  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }


}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {

  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }

  }


}

resource "aws_s3_bucket_public_access_block" "state" {

  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}

resource "aws_s3_bucket_policy" "state" {

  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }

      }

      }
    ]
    }
  )

}

resource "aws_iam_openid_connect_provider" "github" {
  depends_on = [terraform_data.configuration_guard]

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

}

output "state_kms_arn" {
  value = aws_kms_key.state.arn
}

output "github_oidc_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}
