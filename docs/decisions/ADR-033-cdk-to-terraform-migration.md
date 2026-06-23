---
status: Proposed
date: 2026-06-19
verification_required: true
---

# ADR-033: IaC 단일화 — CDK 폐기, Terraform으로 완전 이관

## Status: Proposed

## Date: 2026-06-19

## Context

레포는 동일 인프라를 CDK(TS)·Terraform(HCL)·CloudFormation(YAML) 3중으로 유지해왔다(CLAUDE.md). 실제로는 **CDK만 최신·작동 상태**이고 Terraform은 미완성 스켈레톤이다(`terraform/CLAUDE.md` "Drift vs CDK"):

- root `main.tf`가 8개 중 **5개 모듈만** 호출 — `usage-tracking`/`local-governance`/`waf`는 **미배선**(apply해도 안 생김).
- 핵심 런타임 부재: **nginx-config-gen**(code-server 라우팅 ADR-027), **OTel 생산성 파이프라인**(ADR — S3/GSI/rollup/collector), **cognito JIT 트리거**(ADR-028)+**UserRoleProvisioner**(ADR-022), **ADR-032 데이터 EBS IAM**(오늘), DNS Firewall, ADR-016 CloudFront split, `governanceOnly` 플래그.
- `usage` DynamoDB 테이블이 미배선 모듈에 있어 — 현재 TF apply는 **사용량 추적조차 없는** 환경을 만든다.

3중 IaC 동기화 비용이 실효 없이 누적되고, 최근 모든 기능(ADR-026~032, OTel, email-key)이 CDK에만 반영됐다. 사용자 결정: **CDK를 완전히 버리고 Terraform을 단일 정본 IaC로 삼는다.**

## Decision

**Terraform을 유일한 IaC로 단일화한다. CDK(`cdk/`)는 인프라 정의로서 폐기한다.**

단, **Lambda 런타임 코드(`lambda/*.py`)와 Next.js 대시보드 앱(`shared/nextjs-app`)·AMI 빌드(`scripts/build-ami.sh`)는 IaC 무관 자산으로 유지**한다 — Terraform이 `lambda/`에서 직접 `archive_file`로 패키징하므로 Lambda 로직은 이미 TF로 흐른다. (디렉터리명 `lambda`는 역사적 잔재이나 경로 의존이 많아 이번 범위에서 개명하지 않는다.)

CloudFormation(`cloudformation/`)도 동일 사유로 정리 대상이나 본 ADR 범위 밖(별도 후속).

### 시퀀싱 (필수)
되돌릴 수 없는 파괴는 **TF가 작동 가능해진 뒤** 실행한다:
1. **Parity 빌드** — 아래 체크리스트를 TF에 구현, `terraform validate`/`plan` 통과(무파괴).
2. **CDK teardown** — `cdk destroy --all`(S3 버킷 비우기 선행). 사용자 최종 승인 후.
3. **`terraform apply`** + 사후 셋업(Cognito admin, ECR 이미지 push, AMI 빌드+SSM param, `verify-deployment.sh`).
4. 검증 통과 시 본 ADR `status: Accepted`, `cdk/` 폐기 표식.

전제: **dev 계정, 상태 데이터(Cognito/DynamoDB/Secrets 등) 전부 삭제 동의** (사용자 확인됨).

## Parity 체크리스트 (CDK → TF, 구현 정본은 [migration plan](../superpowers/specs/2026-06-19-cdk-to-terraform-migration-plan.md))

- **root main.tf**: `usage-tracking`/`local-governance`/`waf` 모듈 배선 + vpc/subnet/kms/cognito/collector-endpoint 전달.
- **usage-tracking**: day-user GSI, otel-metrics-raw S3(+SSE/lifecycle/notification), otel-metrics-rollup Lambda(multi-source archive: otel-metrics-rollup.py + otel_rollup.py), OTel collector Fargate + internal NLB:4317 + SG + autoscaling + ECR ref, endpoint output, vpc/subnet vars.
- **security**: ADR-032 데이터볼륨 IAM(CreateVolume/Attach/Detach/Modify/Delete 태그조건, DescribeSubnets, ssm:SendCommand split) + 부모 정책; cognito-provisioner-trigger Lambda + pool 트리거(ADR-028); UserRoleProvisioner + EventBridge + DLQ(ADR-022); cc-dept-mcp-config 접근; `lambda_src_dir` var.
- **ecs-devenv**: nginx-config-gen Lambda(ADR-027, VPC_CIDR/INSTANCE_TABLE env + cc-user-instances UpdateItem IAM); DLP SG 1024-65535; 중복 DLP SG 세트 정리.
- **dashboard**: OTEL_COLLECTOR_ENDPOINT user_data 주입.
- **network**: Route 53 Resolver DNS Firewall(DLP DNS 계층).
- **횡단**: ADR-016 CloudFront split(Dashboard/DevEnv 분리 + us-east-1 ACM), `governanceOnly` 동등 변수.

## Consequences

### 긍정
- 단일 IaC — 동기화 비용 제거, 드리프트 종식.
- TF가 비로소 작동하는 전체 시스템을 세움(현재 불가).

### 부정 / 위험
- 대형 일회성 포팅 + 재검증; 누락 시 런타임 결함(라우팅/추적/프로비저닝)이 배포 후에야 드러남 → `terraform plan` + `verify-deployment.sh` + 단계 검증 필수.
- 파괴-후-재구축 동안 환경 공백(시퀀싱으로 최소화: parity-first).
- CDK-온리 미세 동작(ADR-016 split, DNS Firewall) 누락 리스크 — 체크리스트로 추적.

### 보안
- 파괴 시 Secrets/Cognito/KMS 재생성 — 신규 시크릿값. 0.0.0.0/0·Principal:"*"·평문 시크릿 도입 없음(TF 모듈 검토 유지).
- ADR-026 boundary 불변식은 TF security 모듈에서도 유지(`check-policyset-boundary.py`는 synth JSON 기반이므로 TF용 동등 검증 필요 — 후속).
