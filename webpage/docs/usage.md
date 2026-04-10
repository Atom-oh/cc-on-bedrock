# 사용법 (Usage)

CC-on-Bedrock의 설치 및 사용 방법에 대한 안내입니다.

## 1. 인프라 배포 (Deployment)

시스템은 세 가지 IaC 도구 중 원하는 하나를 선택하여 배포할 수 있습니다.

### AWS CDK (권장)
```bash
cd cdk
npm install
npx cdk deploy --all
```

### Terraform
```bash
cd terraform
terraform init
terraform apply
```

### CloudFormation
```bash
cd cloudformation
bash deploy.sh
```

## 2. 대시보드 사용 (Dashboard)

배포된 대시보드를 통해 다음 기능을 이용할 수 있습니다.

- **AI 비서**: Bedrock 기반의 고속 스트리밍 AI와 대화
- **분석**: 모델별, 부서별, 사용자별 사용 통계 및 비용 트렌드 분석
- **모니터링**: ECS 컨테이너의 CPU, 메모리, 네트워크 실시간 현황 확인
- **보안**: IAM 정책 관리, DLP 상태, DNS Firewall 차단 내역 관리
- **사용자 관리**: Cognito 기반의 사용자 추가, 권한 부여 및 관리
- **컨테이너 관리**: 사용자별 ECS 컨테이너 시작/중지 및 EFS 파일 시스템 관리

## 3. 개발 환경 접속 (Dev Environment)

1. 대시보드의 **Containers** 메뉴에서 자신의 컨테이너를 시작합니다.
2. 할당된 서브도메인 (예: `user1.dev.domain.com`)으로 접속합니다.
3. 웹 브라우저 기반의 VS Code (code-server) 환경이 실행됩니다.
4. 터미널에서 `claude` 또는 `kiro` 명령어를 통해 AI 에이전트를 사용합니다.
