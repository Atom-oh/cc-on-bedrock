import re
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]


def test_devenv_cloudfront_uses_viewer_request_lambda_edge_validator():
    main_tf = (REPO / "terraform/modules/ecs-devenv/main.tf").read_text()
    root_tf = (REPO / "terraform/main.tf").read_text()
    providers_path = REPO / "terraform/modules/ecs-devenv/providers.tf"

    assert providers_path.exists()
    providers_tf = providers_path.read_text()
    assert "aws.us_east_1" in providers_tf
    assert "aws_lambda_function\" \"devenv_session_validator" in main_tf
    assert re.search(r"provider\s+=\s+aws\.us_east_1", main_tf)
    assert re.search(r"publish\s+=\s+true", main_tf)
    assert "aws_lambda_function.devenv_session_validator.qualified_arn" in main_tf
    assert "lambda_function_association" in main_tf
    assert 'event_type   = "viewer-request"' in main_tf
    assert "include_body = false" in main_tf
    assert "aws.us_east_1 = aws.us_east_1" in root_tf


def test_scripts_do_not_reference_removed_cdk_entrypoints():
    stale_patterns = [
        "npx cdk",
        "cd cdk",
        "./02-cdk-bootstrap.sh",
        "./03-deploy-base-stacks.sh",
        "./06-deploy-service-stacks.sh",
        "aws-cdk:subnet-type",
        "cloudformation describe-stacks",
    ]
    paths = list((REPO / "scripts").glob("*.sh")) + list((REPO / "tests/integration").glob("*.sh"))

    offenders = []
    for path in paths:
        text = path.read_text()
        for pattern in stale_patterns:
            if pattern in text:
                offenders.append(f"{path.relative_to(REPO)} contains {pattern!r}")

    assert offenders == []
