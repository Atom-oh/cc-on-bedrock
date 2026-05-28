terraform {
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

# us-east-1 alias — required by:
#   - CloudFront-scope WAF WebACL (ADR-019, scope CLOUDFRONT must live in us-east-1)
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
