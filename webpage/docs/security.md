# 보안 (Security)

import SecurityLayers from '@site/src/components/InteractiveDoc/SecurityLayers';
import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock은 기업 환경에서도 안전하게 사용할 수 있도록 설계된 **7계층 보안 모델**을 적용하고 있습니다.

<SecurityLayers />

## 보안 관리 대시보드
대시보드에서는 보안 정책을 시각적으로 관리하고 위협 로그를 실시간으로 모니터링할 수 있습니다.

<Screenshot 
  src="/cc-on-bedrock/img/security.png" 
  alt="Security Dashboard" 
  caption="통합 보안 대시보드: IAM, DLP, DNS Firewall 통합 관리 화면" 
/>

## 7계층 보안 모델 상세

| 계층 | 구성 요소 | 주요 보호 기능 |
|-------|-----------|------------|
| L1 | CloudFront | HTTPS 암호화 (TLS 1.2+), AWS Shield를 통한 DDoS 방어 |
| L2 | ALB | CloudFront Prefix List 및 X-Custom-Secret 헤더를 통한 직접 접근 차단 |
| L3 | Cognito | OAuth 2.0 기반 인증, 관리자/일반 사용자 그룹 기반 접근 제어 |
| L4 | Security Groups | 3단계 데이터 유출 방지 (DLP): Open / Restricted / Locked 정책 |
| L5 | VPC Endpoints | AWS Private Link를 활용하여 인터넷을 거치지 않는 내부 전송 |
| L6 | DNS Firewall | 5개의 AWS 위협 목록 및 사용자 정의 차단 목록 적용 |
| L7 | IAM + DLP | 모델별 접근 제어, 예산 초과 시 Deny Policy, 파일 전송 제한 정책 |

## 데이터 유출 방지 (DLP) 정책

보안 그룹(Security Group)을 통해 개발 환경의 네트워크 환경을 유동적으로 관리할 수 있습니다:

- **Open**: 자유로운 인터넷 아웃바운드 허용 (기본값)
- **Restricted**: 사전에 정의된 특정 도메인(예: GitHub, npm)만 허용
- **Locked**: 모든 인터넷 아웃바운드 차단 및 VPC 엔드포인트를 통한 AWS 서비스 접근만 허용
