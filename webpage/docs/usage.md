# 사용법 (Usage)

CC-on-Bedrock의 설치 및 사용 방법에 대한 안내입니다. 자세한 단계별 배포는
[배포 가이드](./deployment.md)를, 사용자/관리자 인터페이스는
[내 환경](./user-portal.md) / [Local Governance Mode](./local-mode.md)를 참고하세요.

## 1. 인프라 배포 (Deployment)

시스템은 세 가지 IaC 도구 중 원하는 하나를 선택하여 배포할 수 있습니다.

### AWS CDK (권장)
```bash
cd cdk
npm install
npx cdk deploy --all                          # EC2 + Local 모두 배포
npx cdk deploy --all -c governanceOnly=true   # Local Governance 전용
```

### Terraform
```bash
cd terraform
terraform init
terraform validate
terraform apply
```

### CloudFormation
```bash
cd cloudformation
bash deploy.sh
```

## 2. 대시보드 사용 (Dashboard)

배포된 대시보드를 통해 다음 기능을 이용할 수 있습니다.

- **AI 비서 (`/ai`)**: Bedrock Converse API 기반 고속 스트리밍 AI 대화 + 5개 tool use
- **분석 (`/analytics`)**: 모델별, 부서별, 사용자별 토큰 사용량 + 비용 트렌드
- **모니터링 (`/monitoring`)**: EC2 인스턴스 CPU/Memory/Network, Bedrock 사용량
- **보안 (`/security`)**: IAM 정책, DLP 상태, DNS Firewall 차단 내역
- **사용자 관리 (`/admin`)**: Cognito 사용자 CRUD, 권한 부여
- **인스턴스 관리 (`/admin/instances`)**: 사용자별 EC2 시작/중지, 티어 변경
- **토큰 / 예산 (`/admin/tokens`, `/admin/budgets`, `/admin/limits`)**: 사용량
  대시보드 + USD 예산 + Normalized 토큰 한도 (ADR-015)
- **MCP 게이트웨이 (`/admin/mcp`)**: 부서별 MCP 서버 카탈로그 + 게이트웨이 동기화 (ADR-007)

Bedrock 모델은 ap-northeast-2의 inference profile을 사용합니다:
**Claude Opus 4.7 / 4.6 (1M context) / Sonnet 4.6 / Haiku 4.5**.

## 3. 개발 환경 접속 (Dev Environment)

배포 프로파일에 따라 두 가지 모드를 사용합니다 (공존 가능).

### 3-A. EC2-per-user DevEnv 모드 (기본, ADR-004)

1. 대시보드의 **내 환경** 페이지에서 컨테이너(=EC2 인스턴스) Start
2. 6단계 SSE 프로비저닝 (Cold start ~30s, Hibernation resume ~5s)
3. 할당된 서브도메인 (예: `user1.dev.atomai.click`)으로 접속
4. 웹 브라우저 기반 VS Code (code-server) 환경 실행
5. 터미널에서 `claude` (또는 `kiro`) — Instance Profile 자격증명으로 Bedrock 직접 호출

자세한 셀프서비스 가이드는 [내 환경](./user-portal.md) 참고.

### 3-B. Local Governance 모드 (ADR-014)

본인 PC에서 `claude` 직접 실행하면서 회사 거버넌스(IAM 권한, 토큰 한도, 사용량
추적)를 그대로 적용받는 모드입니다. EC2를 띄우지 않으므로 인프라 비용이
들지 않습니다.

```bash
# CLI 설치 (정식 채널: /api/install/cli)
curl -fsSL https://cconbedrock-dashboard.<domain>/api/install/cli \
  -o ~/.local/bin/cc-bedrock-local
chmod +x ~/.local/bin/cc-bedrock-local

# 로그인 + claude 실행
cc-bedrock-local login
cc-bedrock-local claude
```

설치 / 설정 / 어드민 컨트롤 가이드는 [Local Governance Mode](./local-mode.md) 참고.
