terraform {

  required_version = "= 1.16.5"
  required_providers {

    aws = {
      source = "hashicorp/aws", version = "= 6.67.0"
    }

    mongodbatlas = {
      source = "mongodb/mongodbatlas", version = "= 2.17.0"
    }


  }

  backend "s3" {

  }


}

provider "aws" {

  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      Project = "scaling-lab", Environment = var.environment, Owner = var.incident_owner
    }

  }


}

provider "mongodbatlas" {

}

