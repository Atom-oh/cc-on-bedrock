# 사용법 (Usage)

import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock 대시보드를 활용하여 인프라를 관리하고 AI 어시스턴트와 협업하는 방법에 대해 설명합니다.

## 1. 홈 (Home)
대시보드에 접속하면 가장 먼저 보이는 화면으로, 전체 플랫폼의 핵심 지표를 한눈에 파악할 수 있습니다.

<Screenshot 
  src="/img/home.png" 
  alt="Dashboard Home" 
  caption="플랫폼 개요: 비용, 토큰 사용량, 활성 컨테이너 및 클러스터 메트릭" 
/>

- **주요 지표**: 금일 총 비용, 사용된 토큰 수, 실행 중인 ECS 태스크 수 확인
- **리소스 현황**: CPU 및 메모리 예약 현황을 그래프로 모니터링

## 2. AI 어시스턴트 (AI Assistant)
Amazon Bedrock의 Converse API를 활용하여 실시간 스트리밍 답변을 제공하는 지능형 비서입니다.

<Screenshot 
  src="/img/AI_Assistant.png" 
  alt="AI Assistant" 
  caption="Bedrock Converse API + Tool Use 기반의 지능형 채팅 인터페이스" 
/>

- **고속 스트리밍**: 토큰 단위의 실시간 응답으로 지연 없는 대화 가능
- **도구 활용 (Tool Use)**: 인프라 조회, 코드 분석 등 내장된 도구를 AI가 직접 호출
- **컨텍스트 공유**: AgentCore Memory를 통해 이전 대화 맥락을 완벽히 유지

## 3. 분석 (Analytics)
플랫폼 사용량과 비용 트렌드를 심층적으로 분석할 수 있는 도구를 제공합니다.

<Screenshot 
  src="/img/Analytics01.png" 
  alt="Analytics Trends" 
  caption="모델별/부서별 비용 트렌드 및 사용량 분석" 
/>

- **비용 트렌드**: 일별/주별 비용 변화를 선그래프로 시각화
- **분포도 분석**: 부서별, 모델별 점유율을 파이 차트로 확인

<Screenshot 
  src="/img/Analytics02.png" 
  alt="Analytics Leaderboard" 
  caption="사용자별 사용량 리더보드 및 상세 통계" 
/>

- **리더보드**: 어떤 사용자가 가장 많은 리소스를 효율적으로 사용하는지 순위 확인

## 4. 모니터링 (Monitoring)
인프라의 건강 상태와 성능을 실시간으로 감시합니다.

<Screenshot 
  src="/img/monitoring.png" 
  alt="Infrastructure Monitoring" 
  caption="Container Insights 기반의 ECS 성능 메트릭 시각화" 
/>

- **Container Insights**: 개별 태스크 및 서비스의 CPU/메모리/네트워크 사용량 상세 모니터링
- **상태 확인**: ECS 클러스터 및 서비스의 가용성 실시간 체크

## 5. 보안 (Security)
플랫폼의 보안 정책과 위협 방어 현황을 중앙에서 관리합니다.

<Screenshot 
  src="/img/security.png" 
  alt="Security Dashboard" 
  caption="IAM 정책, DLP 상태, DNS Firewall 차단 내역 통합 관리" 
/>

- **DLP 제어**: 보안 그룹 기반의 데이터 유출 방지 정책(Open/Restricted/Locked) 설정
- **위협 감사**: DNS Firewall에 의한 유해 도메인 차단 내역 및 CloudTrail 감사 로그 확인

## 6. 사용자 관리 (Users)
Amazon Cognito와 연동된 사용자 계정 및 권한을 관리합니다.

<Screenshot 
  src="/img/user.png" 
  alt="User Management" 
  caption="Cognito 기반 사용자 리스트 및 상태 관리" 
/>

- **계정 제어**: 사용자 추가/수정/삭제 및 부서/권한 할당
- **필터링**: 운영체제(OS), 티어(Tier)별 사용자 정렬 및 검색

## 7. 컨테이너 관리 (Containers)
개발자별 개별 개발 환경(ECS Task)을 직접 제어합니다.

<Screenshot 
  src="/img/containers.png" 
  alt="Container Management" 
  caption="ECS 태스크 라이프사이클 제어 및 EFS 파일 시스템 관리" 
/>

- **태스크 제어**: 사용자별 컨테이너 시작, 중지, 재시작 및 터미널 접속
- **중복 방지**: 한 사용자당 하나의 태스크만 실행되도록 자동 제어 로직 적용
