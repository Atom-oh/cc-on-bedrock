terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # us_east_1: bedrock-mantle (Codex GPT models exist only there) audit trail.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
