terraform {
  backend "s3" {
    bucket       = "cc-on-bedrock-tfstate-180294183052"
    key          = "cc-on-bedrock/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }

  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "cc-on-bedrock"
      ManagedBy = "terraform"
    }
  }
}

# CLOUDFRONT-scope WAF must be created in us-east-1 (ADR-016).
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "cc-on-bedrock"
      ManagedBy = "terraform"
    }
  }
}
