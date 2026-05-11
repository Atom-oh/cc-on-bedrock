# Runbook: Local Governance Mode Onboarding & Operations

> Related: [ADR-014](../decisions/ADR-014-local-governance-mode.md), [plans/local-governance-mode.md](../plans/local-governance-mode.md)

## Scope
Local PC에서 Claude Code를 Bedrock에 직접 연결해 쓰는 사용자(Local Governance Mode)의 온보딩 및 일상 운영 절차.

---

## 1. 신규 사용자 온보딩

### 1.1 Cognito 계정 발급 (관리자)
1. 대시보드 **Admin → Users → Create User** 진입
2. 이메일, 부서, 프로젝트 입력. 모드는 **Local** 선택
3. 임시 비밀번호로 초대 이메일 발송
4. 사용자가 첫 로그인 시 비밀번호 재설정

### 1.2 한도 설정 (관리자)
1. **Admin → Limits** 페이지
2. 사용자 normalized token 한도 입력
   - 권장 기본값(개발자 1인 기준): daily 5M / weekly 25M / monthly 80M normalized tokens
   - normalized 환산: Opus 1.0 / Sonnet 0.2 / Haiku 0.053 (input), output은 ~5배 가중
3. 부서 한도가 없으면 함께 설정 (부서 한도가 사용자 합보다 작으면 부서 한도가 우선)

### 1.3 사용자 측 셋업
1. 대시보드 로그인 후 **Local** 메뉴 진입
2. `tools/cc-bedrock-local.sh` 다운로드 → PATH에 두기 (예: `~/.local/bin/`, `chmod +x`)
3. 최초 실행:
   ```bash
   cc-bedrock-local refresh   # 브라우저 OIDC 로그인 후 ~/.aws/credentials [cc-bedrock] 생성
   ```
4. Claude Code 실행:
   ```bash
   export CLAUDE_CODE_USE_BEDROCK=1
   export AWS_PROFILE=cc-bedrock
   export AWS_REGION=ap-northeast-2
   claude
   ```
   또는 단축 명령:
   ```bash
   cc-bedrock-local run -- claude
   ```

### 1.4 검증
```bash
# 자격증명 만료 시각 확인 (8h 발급)
aws sts get-caller-identity --profile cc-bedrock
# 결과 Arn이 cc-on-bedrock-local-user-{sub}여야 함

# 1회 호출 테스트
aws bedrock-runtime converse \
  --profile cc-bedrock --region ap-northeast-2 \
  --model-id global.anthropic.claude-sonnet-4-6 \
  --messages '[{"role":"user","content":[{"text":"hello"}]}]'
```

대시보드 **Local** 페이지의 남은 토큰 게이지가 줄어드는 것을 확인 (Invocation Logging 지연으로 1-3분 후 반영).

---

## 2. 한도 초과 차단 처리

### 2.1 증상
- 사용자가 `AccessDeniedException`을 받았다고 보고
- 메시지에 `BedrockLocalLimitExceeded` 또는 reset 시각 포함

### 2.2 진단
```bash
SUB="<cognito-sub>"

# 1) 현재 부착된 Deny policy 확인
aws iam list-role-policies \
  --role-name cc-on-bedrock-local-user-$SUB \
  --region ap-northeast-2

# 2) DENY#active 아이템 확인 (reason, reset_at)
aws dynamodb get-item \
  --table-name cc-on-bedrock-limits \
  --key '{"PK":{"S":"USER#'$SUB'"},"SK":{"S":"DENY#active"}}'

# 3) 현재 사용량 카운터
aws dynamodb query \
  --table-name cc-on-bedrock-limits \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :sk)' \
  --expression-attribute-values '{":pk":{"S":"USER#'$SUB'"},":sk":{"S":"COUNTER#"}}'
```

### 2.3 조치
- **정상 한도 도달**: 다음 reset 까지 대기 안내 (DENY#active의 `reset_at` 참조)
- **한도가 너무 낮음**: Admin → Limits 에서 한도 상향 → 강제 reset 버튼으로 즉시 해제
- **부서 한도 도달이 원인**: 부서 관리자에게 통보, 부서 한도 조정

### 2.4 수동 강제 해제 (긴급)
```bash
SUB="<cognito-sub>"

# Deny policy 제거
aws iam delete-role-policy \
  --role-name cc-on-bedrock-local-user-$SUB \
  --policy-name cc-bedrock-local-deny-$SUB

# DENY#active 아이템 삭제
aws dynamodb delete-item \
  --table-name cc-on-bedrock-limits \
  --key '{"PK":{"S":"USER#'$SUB'"},"SK":{"S":"DENY#active"}}'
```

> ⚠ 수동 해제는 audit 추적이 어렵습니다. 가능하면 대시보드 강제 reset 버튼 사용.

---

## 3. 자격증명 관리

### 3.1 자격증명 갱신
- TTL 8시간. 만료 1시간 전부터 wrapper가 자동 갱신 시도
- 수동 갱신: `cc-bedrock-local refresh`

### 3.2 자격증명 유출 의심
1. **즉시**: user role disable
   ```bash
   aws iam put-role-policy \
     --role-name cc-on-bedrock-local-user-$SUB \
     --policy-name cc-bedrock-local-emergency-deny \
     --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'
   ```
2. **CloudTrail 조사**: principal = role ARN으로 최근 호출 검토
3. 새 자격증명 발급 후 사용자에게 안내, 위 emergency-deny 제거

### 3.3 사용자 오프보딩
1. Cognito에서 사용자 disable (`admin-disable-user`)
2. IAM role 삭제: `aws iam delete-role --role-name cc-on-bedrock-local-user-$SUB`
3. `cc-on-bedrock-limits`의 사용자 아이템 정리 (또는 TTL 만료 대기)
4. 사용량 이력(`cc-on-bedrock-usage`)은 audit 목적으로 보존

---

## 4. 일상 모니터링 체크리스트

| 빈도 | 항목 | 위치 |
|---|---|---|
| 매일 | normalized token 합산(부서별) | Dashboard → Monitoring |
| 매일 | Deny 부착 사용자 수 | Dashboard → Limits |
| 매주 | reset cron 정상 실행 (3개) | CloudWatch Logs `/aws/lambda/limit-reset` |
| 매주 | token-limit-enforcer 실패율 | CloudWatch Metrics, < 0.1% 목표 |
| 매월 | CUR 2.0 비용 vs DynamoDB 추정 비용 reconcile | Cost Explorer |

---

## 5. 트러블슈팅

### "한도를 안 넘었는데 차단됨"
- normalized 가중치 확인 (`cc-on-bedrock-limits` 사용자 아이템의 `weights` override)
- 부서 한도 초과 여부 (사용자 한도와 AND)

### "사용량이 대시보드에 안 보임"
- Invocation Logging 지연(1-3분) 대기
- `bedrock-usage-tracker` CloudWatch Logs에 에러 확인
- role tags(`username`, `department`)가 빠지면 attribute 실패 — STS Issuer Lambda가 role 생성 시 태그 부착 검증

### "STS Issuer가 500 반환"
- Cognito ID 토큰 만료 → 사용자 재로그인
- Lambda IAM 권한: `sts:AssumeRole` + `iam:CreateRole`/`PutRolePolicy`/`TagRole` 필요 (신규 사용자 첫 발급 시)
