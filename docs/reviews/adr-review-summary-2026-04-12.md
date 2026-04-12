# ADR Review Summary (2026-04-12)

> **대상**: ADR-007 (부서별 MCP Gateway) + ADR-008 (Enterprise SSO Federation)
> **리뷰어**: Gemini 2.5 Pro (0.35.3), Kiro CLI (1.28.3), Claude Opus 4.6 (Codex 대체)
> **참고**: Codex CLI가 ChatGPT 계정 모델 제한으로 실패하여 Claude가 코드 정확성 리뷰를 대체 수행

---

## Review Status

| LLM | Model | 대상 | 소요시간 | 발견 건수 | 상태 |
|-----|-------|------|----------|----------|------|
| Gemini | gemini-2.5-pro | ADR 문서 + 구현 코드 | ~60s | 12건 (C1/H3/M4/L3) | ✅ 완료 |
| Kiro | kiro-cli 1.28.3 | ADR 문서 + 구현 코드 (Well-Architected) | ~138s | 12건 (C3/I9) | ✅ 완료 |
| Claude | opus-4.6 (Codex 대체) | 구현 코드 정확성 + 보안 | N/A | 14건 (C3/H5/M5/L1) | ✅ 완료 |
| Codex | gpt-5.4 | 구현 코드 | ~180s | 0건 | ❌ 모델 제한 실패 |

---

## 🔴 Consensus Findings — 2개+ LLM 동의 (최우선 수정)

### C1. Lambda handler 이름 불일치 → 런타임 에러 ⭐ **3-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| CRITICAL (handler vs lambda_handler) | CRITICAL (conf: 99) | (미발견) |

- **위치**: `03-usage-tracking-stack.ts:440` ↔ `gateway-manager.py:371`
- **CDK**: `handler: 'gateway-manager.handler'` / **Python**: `def lambda_handler(event, context)`
- **영향**: Gateway 생성/삭제가 **전혀 동작하지 않음** (Runtime.HandlerNotFound)
- **수정**: CDK에서 `handler: 'gateway-manager.lambda_handler'`로 변경

### C2. Permission Boundary 미적용 — 동적 IAM Role ⭐ **2-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| CRITICAL (PermissionsBoundary 없음) | CRITICAL (conf: 95) | (미발견) |

- **위치**: `gateway-manager.py:93-102`
- `create_role()`에 `PermissionsBoundary` 파라미터 없음
- `02-security-stack.ts`에 `cc-on-bedrock-task-boundary` 정의되어 있으나 미적용
- **수정**: `PermissionsBoundary=f"arn:aws:iam::{account_id}:policy/cc-on-bedrock-task-boundary"` 추가

### C3. IAM 과다 권한 (AttachRolePolicy, PassRole) ⭐ **2-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| CRITICAL (AttachRolePolicy 불필요 + PassRole 무조건) | HIGH (conf: 92) | (미발견) |

- **위치**: `03-usage-tracking-stack.ts:479-486`
- `iam:AttachRolePolicy`, `iam:DetachRolePolicy` — 코드에서 미사용, privilege escalation 경로
- `iam:PassRole`에 `iam:PassedToService` condition 없음
- **수정**: 불필요 액션 제거 + PassRole condition 추가

### C4. DELETE API PutItem으로 gatewayId 덮어쓰기 ⭐ **2-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| IMPORTANT (PutItem → gatewayId 유실 → 삭제 실패) | CRITICAL (conf: 97) | (미발견) |

- **위치**: `gateways/route.ts:105-116` → `gateway-manager.py:219-224`
- DELETE handler가 PutItem으로 전체 아이템 교체 → `gatewayId` 사라짐 → Lambda 삭제 실패
- 또한 MODIFY 이벤트가 `handle_stream_event()`에서 무시됨
- **수정**: `PutItemCommand` → `UpdateItemCommand` + MODIFY 케이스 처리 추가

### C5. API 입력값 검증 부재 ⭐ **2-way consensus**
| Gemini | Claude | Kiro |
|--------|--------|------|
| CRITICAL (zod 등 스키마 검증 필요) | HIGH (conf: 88) | (Catalog은 GOOD 평가) |

- **위치**: `gateways/route.ts:59-64`
- `department` 값에 특수문자/슬래시 포함 시 의도치 않은 DDB PK 생성
- **수정**: 영숫자+하이픈만 허용하는 정규식 검증 추가

### C6. ADR-008 ALLOWED_DOMAINS 미설정 시 전체 허용 ⭐ **3-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| IMPORTANT (빈 문자열 = 전체 허용) | HIGH (conf: 90) | HIGH (이메일 변경 우회) |

- **위치**: ADR-008 line 407-408
- 환경변수 미설정 → 빈 배열 → domain allowlist 무력화
- **수정**: 빈 배열 = 기본 차단, 또는 별도 `ALLOW_ALL_DOMAINS=true` 플래그

### C7. PreTokenGeneration V2 cognito:groups override 방식 ⭐ **3-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| IMPORTANT (groupOverrideDetails 사용 필요) | HIGH (conf: 85) | (언급) |

- **위치**: ADR-008 line 506
- `claimsToAddOrOverride`로 `cognito:groups` reserved claim을 override할 수 없을 가능성
- `JSON.stringify(groupNames)`는 문자열, `middleware.ts`는 배열 기대 → 파싱 불일치
- **수정**: `groupOverrideDetails.groupsToOverride` 사용 + Cognito V2 스펙 검증

### C8. Gateway 생성/삭제 부분 실패 시 rollback 부재 ⭐ **2-way consensus**
| Kiro | Claude | Gemini |
|------|--------|--------|
| CRITICAL (orphan IAM Role) | HIGH (conf: 88) | (미발견) |

- **위치**: `gateway-manager.py:151-210`, `213-256`
- IAM Role 생성 → Gateway 생성 실패 시 orphan Role
- **수정**: compensating transaction 패턴 또는 ERROR 상태에 실패 단계 기록

---

## 🟡 Unique Findings — 단일 LLM만 발견

### Kiro 단독 발견
| # | 심각도 | 발견사항 | 위치 |
|---|--------|----------|------|
| K1 | IMPORTANT | DDB 테이블 암호화 불일치 (cc-dlp-domain-lists에 CMK 없음) | `03-usage-tracking-stack.ts:60` |
| K2 | IMPORTANT | DDB Streams MODIFY 이벤트 미처리 | `gateway-manager.py:195-210` |
| K3 | IMPORTANT | DLQ CloudWatch 알람 미정의 | `03-usage-tracking-stack.ts` |
| K4 | IMPORTANT | SQS DLQ RemovalPolicy 미설정 (DESTROY 기본값) | `03-usage-tracking-stack.ts:431` |
| K5 | IMPORTANT | EC2 config sync (systemd oneshot) 미구현 확인 | ADR-007 vs 코드 |
| K6 | GOOD | Catalog API의 ALLOWED_FIELDS 화이트리스트 | `catalog/route.ts:73-76` |
| K7 | GOOD | SQS DLQ 14일 retention | `03-usage-tracking-stack.ts:273-276` |
| K8 | GOOD | Cognito trigger 비용 분석 (무시 가능) | ADR-008 |

### Gemini 단독 발견
| # | 심각도 | 발견사항 | 위치 |
|---|--------|----------|------|
| G1 | HIGH | ADR-007↔ADR-008 의존성 미명시 (department claim 연동) | ADR-007 전반 |
| G2 | MEDIUM | ADR-007 Consequences 구체화 필요 (운영 시나리오) | ADR-007 |
| G3 | MEDIUM | DynamoDB PK 형식 규칙의 암묵적 의존성 | `gateway-manager.py:38` |
| G4 | MEDIUM | 환경변수 강제 언래핑 (!) — 런타임 다운 가능 | 다수 API route |
| G5 | LOW | IAM Role 작명 규칙 중앙 관리 필요 | 전체 |
| G6 | LOW | Social Login department 속성 한계 명시 필요 | ADR-008 |
| G7 | MEDIUM | Lambda 코드 내 하드코딩 리전/계정ID 잠재적 위험 | `gateway-manager.py` |

### Claude 단독 발견
| # | 심각도 | 발견사항 | 위치 |
|---|--------|----------|------|
| CL1 | MEDIUM | DDB Streams 자기참조 루프 (불필요한 Lambda 호출) | `gateway-manager.py:57-78` |
| CL2 | MEDIUM | time.sleep(10) 고정 대기 — batch 누적 시 timeout 위험 | `gateway-manager.py:119` |
| CL3 | MEDIUM | AgentCore 권한 Resource: * (ARN scope down 필요) | `03-usage-tracking-stack.ts:475` |
| CL4 | MEDIUM | unsafeUnwrap() Apple 비밀키 CFN 노출 | ADR-008 line 363 |

---

## ADR Quality Assessment

### ADR-007 (Accepted) — 품질: 양호
- ✅ Context, Decision, Consequences 구조 적절
- ✅ 2-tier Gateway 아키텍처 명확히 설명
- ✅ DDB 데이터 모델(PK/SK 패턴) 정의
- ⚠️ ADR-008 의존성(department claim) 미명시 — Gemini 지적
- ⚠️ 운영 시나리오(부서 추가/삭제 절차) 구체화 필요 — Gemini 지적
- ⚠️ 3-Layer IAM 격리 설명이 구현(VPC Endpoint Policy)과 미세하게 다름 — Gemini 지적

### ADR-008 (Proposed) — 품질: 우수 (단, Lambda 코드에 핵심 이슈)
- ✅ 5가지 IdP 타입 + 완전한 CDK 코드 포함
- ✅ 변경 불필요 영역 분석 (middleware, Lambda@Edge 등)
- ✅ 제약사항(25 IdP 한도, latency 등) 상세 문서화
- ⚠️ PreTokenGeneration V2의 groups claim 방식 검증 필요 — **3-way consensus**
- ⚠️ ALLOWED_DOMAINS 빈값 처리 로직 — **3-way consensus**
- ⚠️ unsafeUnwrap() Apple 비밀키 — Claude 지적

---

## Design-Implementation Alignment (ADR-007)

| ADR-007 설계 | 구현 상태 | Gap |
|-------------|----------|-----|
| 2-Tier Gateway (Common + Per-Dept) | ✅ 구현됨 | - |
| DDB Streams → Lambda 자동화 | ⚠️ handler 이름 불일치로 미동작 | **CRITICAL** |
| 3-Layer IAM 격리 | ⚠️ Permission Boundary 미적용 | **CRITICAL** |
| Catalog 기반 MCP 관리 | ✅ 구현됨 | - |
| Admin UI (MCP 관리) | ✅ 구현됨 | - |
| EC2 config sync (systemd) | ❌ 미구현 | Kiro 발견 |
| DDB PK 형식 (DEPT#{dept}) | ✅ 일관성 확보 | COMMON→DEPT#COMMON 수정됨 |

---

## Action Items (우선순위)

### 🔥 즉시 수정 (Sprint 0 — 이번 주)
1. **Lambda handler 이름 수정** — CDK `handler: 'gateway-manager.lambda_handler'` (C1)
2. **DELETE API → UpdateItemCommand** + MODIFY 이벤트 처리 (C4)
3. **Permission Boundary 추가** — `create_gateway_role()` (C2)
4. **IAM 과다 권한 제거** — AttachRolePolicy/DetachRolePolicy + PassRole condition (C3)
5. **department 입력값 검증** — 정규식 추가 (C5)

### ⚡ 단기 수정 (Sprint 1 — 다음 주)
6. **ADR-008 PreTokenGeneration V2** — groupOverrideDetails 방식 검증 + 변경 (C7)
7. **ALLOWED_DOMAINS 빈값 처리** — 기본 차단으로 변경 (C6)
8. **Gateway 생성/삭제 rollback** — compensating transaction 패턴 (C8)
9. **unsafeUnwrap() 제거** — Apple 비밀키 (CL4)
10. **DDB Streams 이벤트 필터** — MODIFY 이벤트 불필요한 호출 방지 (CL1)

### 📋 중기 개선 (Sprint 2 — 2주 이내)
11. ADR-007↔008 의존성 문서화 (G1)
12. DLQ CloudWatch 알람 추가 (K3)
13. DLQ RemovalPolicy RETAIN 설정 (K4)
14. DLP 테이블 CMK 암호화 일관성 (K1)
15. EC2 config sync systemd 서비스 구현 (K5)

---

## Reviewer Disagreements

| 항목 | Gemini | Kiro | Claude | 판정 |
|------|--------|------|--------|------|
| DDB Streams startingPosition | (미확인) | LATEST라고 지적 | TRIM_HORIZON 확인 | **Claude 정확** (CDK 코드 line 497: `TRIM_HORIZON`) |
| Catalog API 입력 검증 | CRITICAL (전체 API) | GOOD (ALLOWED_FIELDS 있음) | (GOOD 동의) | **Kiro/Claude 정확** — Catalog에는 whitelist 있음, Gateways에는 없음 |

---

*Generated by Claude Opus 4.6 — Synthesis of Gemini 2.5 Pro + Kiro CLI + Claude (Codex substitute) reviews*
*Review date: 2026-04-12*
