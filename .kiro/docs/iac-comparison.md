# IaC Comparison

이 프로젝트는 동일 아키텍처를 3가지 IaC로 구현합니다.

## CDK (TypeScript) — 추천
- Type-safe configuration (`config/default.ts`)
- L2/L3 constructs로 간결한 코드
- `cdk deploy --all`로 의존성 자동 해결
- Cross-stack 참조: TypeScript 변수 직접 전달

## Terraform (HCL)
- Module-per-stack 구조
- `terraform.tfvars`로 환경별 설정
- 모듈 간 의존성은 변수로 전달 (자동 그래프)
- State 관리 필요 (S3 backend 권장)

## CloudFormation (YAML)
- 네이티브 AWS, 추가 도구 불필요
- `!ImportValue`로 cross-stack 참조
- Shell 스크립트(`deploy.sh`)로 순차 배포
- 가장 verbose하지만 AWS 콘솔에서 직접 확인 가능

## 선택 가이드
| 기준 | CDK | Terraform | CloudFormation |
|------|-----|-----------|----------------|
| 타입 안전성 | ✅ TypeScript | ❌ | ❌ |
| 학습 곡선 | 중간 | 낮음 | 낮음 |
| 코드량 | 적음 | 중간 | 많음 |
| 멀티클라우드 | ❌ | ✅ | ❌ |
| AWS 네이티브 | ✅ | ❌ | ✅ |
