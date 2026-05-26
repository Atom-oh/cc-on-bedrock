# ADR-020: Runtime IAM Policy & Tag Upsert (Replace One-Shot Migration Scripts)

## Status
Accepted (2026-04-17, retrospective documentation 2026-05-12)

## Context
ADR-011(Bedrock IAM Cost Allocation)을 도입하면서 per-user IAM role(`cc-on-bedrock-task-{subdomain}`)에 `username`/`department`/`project` 태그가 필요해졌다. 또한 CloudWatch Agent와 SSM 사용을 위해 role에 `CloudWatchAgentServerPolicy` 권한도 필요했다.

초기 접근:
1. 신규 사용자 생성 시에만 dashboard가 role/policy/tag을 생성
2. 기존 사용자는 일회성 마이그레이션 스크립트(`scripts/migrate-role-tags.sh`)로 backfill

이 모델의 두 가지 실패 케이스가 나타났다:

1. **CloudWatch 권한 누락** — 이전 deploy 사이클에서 만들어진 role은 CloudWatch policy가 없는 상태. EC2 부팅 시 CWAgent가 `AccessDenied`로 metric 송신 실패. 사용자 환경 시작은 성공해도 메트릭이 안 잡혀 dashboard 사용량 차트가 비는 현상.
2. **마이그레이션 스크립트 운영 부담** — 신규 정책 항목이 추가될 때마다 스크립트 갱신 + 수동 실행 필요. CD 파이프라인에 통합되지 않아 휴먼 에러 위험.

## Decision

**Per-user IAM role의 policy와 tag를 "인스턴스 시작 시점에 항상 upsert"** 한다. 마이그레이션 스크립트는 제거.

### 구현 (`shared/nextjs-app/src/lib/ec2-clients.ts`)

`ensureUserInstanceProfile()` 호출 흐름을 다음과 같이 재배치:

```ts
// 이전: try/catch로 role 생성 → catch 안에서만 policy/tag attach
//      → 기존 role은 catch 미진입 → policy/tag 갱신 안 됨
//
// 이후: role create 시도(이미 있으면 무시) → 무조건 PutRolePolicy + TagRole 실행
async function ensureUserInstanceProfile(subdomain, dept, project) {
  try {
    await iam.send(new CreateRoleCommand({ ... }));
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
    // role이 이미 있으면 그냥 진행
  }
  // ↓ catch 밖으로 빼서 "항상" 실행
  await iam.send(new PutRolePolicyCommand({ /* CloudWatch, SSM, Bedrock */ }));
  await iam.send(new TagRoleCommand({ Tags: [
    { Key: 'username',   Value: subdomain },
    { Key: 'department', Value: dept },
    { Key: 'project',    Value: project },
  ]}));
}
```

핵심 변경: `PutRolePolicyCommand`/`TagRoleCommand`를 catch 블록 **밖**으로 이동. 결과적으로 instance start API가 호출될 때마다 IAM 상태가 "원하는 형태"로 재수렴.

### 추가 권한
- `logs:CreateLogGroup` 추가 (CWAgent가 첫 부팅 시 log group 생성 필요)
- Claude CLI를 `/usr/local/bin/claude`로 symlink (PATH 접근성)
- `/usr/bin/apt` sudoers 추가 (`apt-get`만 있으면 `apt` 호출 시 sudo 실패)

### Migration Script 제거
- `scripts/migrate-role-tags.sh` 삭제 (commit `40aebc3`)
- README/CLAUDE.md에서 참조 제거

## Rationale

| 차원 | One-shot migration | Runtime upsert |
|---|---|---|
| 신규 권한 항목 추가 | migration script 갱신 + 수동 실행 | 코드 PR → 다음 instance start 시 자동 적용 |
| 운영 부담 | 수동 단계, 잊기 쉬움 | CD 파이프라인 내장 |
| Idempotency | 별도 dry-run 옵션 필요 | API가 본질적으로 idempotent (PutRolePolicy / TagRole) |
| 신속성 | 일괄 실행 필요 | 사용자 다음 start 즉시 |
| Drift 감지 | 별도 audit 필요 | drift 발생 시 다음 start로 자동 복구 |
| IAM API 호출 부하 | 한 번에 N명 spike | start당 +2-3 API 호출 (negligible) |

핵심 트레이드오프: 사용자 instance start 시 IAM API가 매번 호출되어 약간의 latency(~50-100ms) 추가. 그러나 instance start 자체가 분 단위 절차이므로 무시 가능.

또한 IAM API의 idempotency를 신뢰한다:
- `PutRolePolicy`: same name으로 호출하면 overwrite (no-op if identical document)
- `TagRole`: 기존 tag 값이 같으면 변화 없음, 다르면 update

## Changes

- `shared/nextjs-app/src/lib/ec2-clients.ts`
  - `ensureUserInstanceProfile()`에서 `PutRolePolicyCommand`/`TagRoleCommand`를 try/catch 밖으로 이동
  - `logs:CreateLogGroup` 권한 추가
- `docker/devenv/scripts/setup-common.sh`
  - sudoers에 `/usr/bin/apt` 추가
  - Claude CLI symlink to `/usr/local/bin`
- `scripts/migrate-role-tags.sh` — **삭제**

## Consequences

### Positive
- 기존 user의 권한/tag drift가 다음 start 시 자동 복구 (self-healing)
- 신규 권한 정책 변경이 코드 PR 단위로 점진 배포
- 운영 절차 1단계 감소 (migration 스크립트 실행 의식 행위 제거)
- ADR-011 cost allocation tag가 항상 최신 Cognito attribute와 동기화

### Negative
- Instance start 당 IAM API 호출 2-3건 → IAM rate limit(account 단위 throttle) 도달 가능성 (대규모 동시 시작 시 의식 필요)
- IAM API 일시 장애 시 instance start가 fail. 사용자 체감 신뢰도 영향. mitigation: retry + exponential backoff (이미 SDK 기본 적용)
- "Code = 진실의 원천"이라는 가정이 강해진다. CLI/콘솔로 수동 IAM 변경 시 다음 start에 덮어쓰여짐 — 정상 동작이지만 의도하지 않으면 혼란

### Validation
- Dashboard 사용자 instance 시작 후 CloudWatch metrics이 즉시 들어오는지 확인 (이전엔 권한 누락으로 안 들어왔음)
- IAM API의 `TagRole` audit log를 CloudTrail에서 spot check해 사용자 attribute 변경이 반영되는지 검증

## Out of Scope
- IAM role 자체의 **삭제** 자동화 — 사용자 deprovision 시 role 삭제는 별도 flow (`deleteCognitoUser` + role/profile cleanup)
- Per-instance temporary credential rotation — STS sessions are already short-lived
- Local Governance Mode role(`cc-on-bedrock-local-user-*`)에도 유사 upsert 패턴 적용됨 (ADR-014 `sts-issuer.py:_ensure_role()`)

## References
- ADR-011: Bedrock IAM Cost Allocation (태그 정책의 발단)
- ADR-014: Local Governance Mode (같은 upsert 패턴을 sts-issuer Lambda에서도 채용)
- 관련 commit: `f3a90bf` (upsert + sudo apt + Claude symlink), `40aebc3` (migrate-role-tags.sh 삭제)
- 관련 파일: `shared/nextjs-app/src/lib/ec2-clients.ts`, `cdk/lib/lambda/sts-issuer.py`
