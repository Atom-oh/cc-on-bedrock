---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: [ADR-033]
---

# 001: IaC — Terraform 단일 정본 (CDK/CloudFormation 폐기)

## Status

Accepted (2026-06-23)

## Context

레포는 동일 인프라를 CDK(TS)·Terraform(HCL)·CloudFormation(YAML) 3중으로 유지해왔다. 실제로는 CDK만 최신·작동 상태였고 Terraform은 미완성 스켈레톤, CloudFormation은 방치 상태였다. 최근 기능(OTel 파이프라인, email canonical key, 데이터 EBS IAM 등)이 CDK에만 반영되면서 3중 IaC 동기화 비용이 실효 없이 누적되고 드리프트가 고착됐다.

The repo maintained the same infrastructure across three IaC tools. In practice only CDK was current and working; Terraform was an incomplete skeleton (root `main.tf` wired only 5 of 8 modules, missing usage-tracking/local-governance/waf, nginx routing, OTel pipeline, Cognito JIT, role provisioner, data-EBS IAM). The triple-IaC sync cost produced no value and entrenched drift.

Architecture detail is owned by `../architecture.md` (SSOT) — not re-derived here.

## Decision

**Terraform을 유일한 IaC로 단일화한다. CDK(`cdk/`)와 CloudFormation(`cloudformation/`)은 인프라 정의로서 폐기한다.**

**Terraform is the single source of truth for all infrastructure. CDK and CloudFormation are retired as infrastructure definitions.**

- **Lambda**: 런타임 코드는 repo root `lambda/*.py`에 IaC-무관 자산으로 유지하고, Terraform이 `archive_file`로 직접 패키징·배포한다 (디렉터리명 `lambda`는 역사적 잔재, 개명 안 함).
  Lambda handler source stays in `lambda/`; Terraform packages it via `archive_file`.
- **State**: S3 backend (`cc-on-bedrock-tfstate-{account}`).
- **Permission boundary 및 정책**: Terraform에서 정본으로 작성 (boundary X = AllowInAccount (+ DenyEscalation floor — TF 완전 포팅은 follow-up, 상세·현행강도는 007 참조)).
  Policies, including the permission boundary, are authored in Terraform (see 007).
- Next.js 대시보드 앱(`shared/nextjs-app`)·AMI 빌드(`scripts/build-ami.sh`)도 IaC-무관 자산으로 유지된다.

되돌릴 수 없는 파괴는 parity-first 시퀀싱으로 실행했다: TF parity 빌드 → `terraform validate`/`plan` 무파괴 통과 → CDK/CFN teardown → `terraform apply` + 사후 셋업 → `verify-deployment.sh` 검증. dev 계정에 Terraform 단일 IaC로 배포 완료(241 리소스).

## Consequences

긍정 / Positive
- 단일 IaC — 동기화 비용 제거, 드리프트 종식. Single IaC ends sync cost and drift.
- Terraform이 비로소 전체 시스템을 작동시킴 (이전엔 불가).

부정·위험 / Negative & risk
- 대형 일회성 포팅 + 재검증; 누락 시 런타임 결함(라우팅/추적/프로비저닝)이 배포 후에야 드러남 → `terraform plan` + `verify-deployment.sh` + 단계 검증으로 완화.
- 파괴-후-재구축 동안 환경 공백 (parity-first 시퀀싱으로 최소화).

보안 / Security
- 파괴 시 Secrets/Cognito/KMS 재생성 — 신규 시크릿값. 0.0.0.0/0 · Principal:"*" · 평문 시크릿 도입 없음.
- boundary 불변식은 Terraform security 모듈에서 유지(`check-policyset-boundary.py` 동등 TF 검증은 007 트랙).

## Consolidates

- **ADR-033** (CDK→Terraform 단일화 / migration)

레거시 ADR 본문은 트리에서 제거되었고 git tag `adr-legacy-2026-06-23` + `../history/ADR-MAPPING.md`에 보존된다. 번호 재사용 금지.
Legacy bodies live in git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md`.
