import os
import sys
import importlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("CLOUDFRONT_SECRET", "testsecret")
os.environ.setdefault("DEV_DOMAIN", "dev.example.com")
os.environ.setdefault("VPC_CIDR", "10.0.0.0/16")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")

ncg = importlib.import_module("nginx-config-gen")


def test_valid_subdomain():
    assert ncg.is_valid_subdomain("alice")
    assert ncg.is_valid_subdomain("user-1")
    assert not ncg.is_valid_subdomain("Alice; rm")
    assert not ncg.is_valid_subdomain("a b")
    assert not ncg.is_valid_subdomain("")


def test_valid_path():
    assert ncg.is_valid_route_path("/")
    assert ncg.is_valid_route_path("/preview")
    assert ncg.is_valid_route_path("/api/v1")
    assert not ncg.is_valid_route_path("/Preview")
    assert not ncg.is_valid_route_path("/foo/../bar")
    assert not ncg.is_valid_route_path("/preview/")
    assert not ncg.is_valid_route_path("/_static")  # reserved


def test_valid_container_ip():
    assert ncg.is_valid_container_ip("10.0.1.50")    # within VPC CIDR
    assert not ncg.is_valid_container_ip("8.8.8.8")   # public
    assert not ncg.is_valid_container_ip("not-an-ip")


def test_valid_port():
    assert ncg.is_valid_route_port(5173)
    assert not ncg.is_valid_route_port(8080)  # code-server reserved
    assert not ncg.is_valid_route_port(80)


def test_render_subpath_uses_segment_boundary():
    blocks = ncg.render_custom_locations("alice", [{"path": "/preview", "port": 5173, "label": "v"}])
    assert "location = /preview" in blocks
    assert "location ^~ /preview/" in blocks
    # 경계 없는 ^~ /preview 단독 금지
    assert "location ^~ /preview {" not in blocks


def test_render_root_route_keeps_arg_folder_branch():
    blocks = ncg.render_custom_locations("alice", [{"path": "/", "port": 3000, "label": "f"}])
    assert "location / {" in blocks
    assert "$arg_folder" in blocks


def test_invalid_route_skipped_and_reported():
    routes = [
        {"path": "/ok", "port": 5000, "label": "a"},
        {"path": "/bad", "port": 8080, "label": "b"},  # reserved port
    ]
    valid, status = ncg.validate_routes("alice", routes)
    assert [r["path"] for r in valid] == ["/ok"]
    rejected = [s for s in status if s["state"] == "rejected"]
    assert len(rejected) == 1 and rejected[0]["path"] == "/bad"


def test_invalid_subdomain_rejects_all_routes():
    valid, status = ncg.validate_routes("Bad; subdomain", [{"path": "/ok", "port": 5000, "label": "a"}])
    assert valid == []
    assert all(s["state"] == "rejected" for s in status)
