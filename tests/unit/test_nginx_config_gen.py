"""Unit tests for the nginx config generator (cc-on-bedrock-nginx-config-gen Lambda).

Regression target: during the ~30-60s code-server boot window, users saw a raw
502 instead of the graceful "code-server is starting" page, because the 502
interception was only on the `@codeserver` location — the code-server internal
asset/WebSocket locations (/_static/, /stable-<hash>, /vscode-remote-resource/,
/out/, /webview/, /manifest.json) proxied without `proxy_intercept_errors` +
`error_page ... = @loading_codeserver`. The single upstream's
`max_fails=3 fail_timeout=5s` also marked it DOWN on boot failures, cascading
502s for ~1 minute.
"""
import importlib.util
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LAMBDA = REPO / "cdk/lib/lambda/nginx-config-gen.py"


def _load_module():
    # The Lambda imports boto3/botocore and creates clients at import time. This
    # test only needs the module's nginx template constants, so stub the AWS SDK
    # in sys.modules — the test then runs even where boto3 isn't installed (and
    # never makes a network/credential call), instead of failing with ImportError.
    import sys
    import types

    if "boto3" not in sys.modules:
        boto3_stub = types.ModuleType("boto3")
        boto3_stub.client = lambda *a, **k: None
        boto3_stub.resource = lambda *a, **k: None
        sys.modules["boto3"] = boto3_stub
    if "botocore.exceptions" not in sys.modules:
        sys.modules.setdefault("botocore", types.ModuleType("botocore"))
        botocore_exc = types.ModuleType("botocore.exceptions")
        botocore_exc.ClientError = type("ClientError", (Exception,), {})
        sys.modules["botocore.exceptions"] = botocore_exc

    os.environ.setdefault("AWS_REGION", "ap-northeast-2")
    spec = importlib.util.spec_from_file_location("nginx_config_gen", LAMBDA)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _server_block() -> str:
    m = _load_module()
    # custom_locations: ADR-027 user routes are rendered separately; empty here —
    # this test targets the built-in code-server locations' boot-502 interception.
    return m.SERVER_TEMPLATE.format(
        subdomain="user01", domain="dev.example.com", cloudfront_secret="sek",
        custom_locations="",
    )


def _upstream_block() -> str:
    m = _load_module()
    return m.UPSTREAM_TEMPLATE.format(subdomain="user01", container_ip="10.0.0.5")


def test_codeserver_upstream_not_marked_down_on_boot_failures():
    """The code-server upstream must not be passively marked DOWN (max_fails=0),
    so transient boot-time 502s don't take the whole (single) upstream offline."""
    up = _upstream_block()
    cs_line = next(line for line in up.splitlines() if ":8080" in line)
    assert "max_fails=0" in cs_line, (
        f"code-server upstream should use max_fails=0; got: {cs_line.strip()}"
    )


def test_every_codeserver_location_intercepts_boot_502():
    """Every location proxying to code-server must intercept 502/503/504 and serve
    the @loading_codeserver page, so no raw 502 leaks during code-server boot."""
    sb = _server_block()
    # Each block runs from one `location` keyword to the next.
    blocks = sb.split("location ")
    cs_blocks = [b for b in blocks if "http://codeserver_user01" in b]
    assert cs_blocks, "expected code-server proxy locations in the server block"
    unguarded = [
        b.splitlines()[0].strip()
        for b in cs_blocks
        if not ("proxy_intercept_errors on" in b and "@loading_codeserver" in b)
    ]
    assert not unguarded, (
        f"code-server locations leak raw 502 during boot (missing "
        f"proxy_intercept_errors + @loading_codeserver): {unguarded}"
    )
