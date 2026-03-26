# CC-on-Bedrock Enterprise Edition - Validation 체크리스트

> 생성일: 2026-03-26 | 설계 문서: [enterprise-edition-design.md](../specs/2026-03-26-enterprise-edition-design.md)

## Phase 1: Foundation

- [ ] EBS + S3 동기화: 컨테이너 시작→파일 생성→종료→재시작 → 파일 복원 확인
- [ ] AZ 이동 복원: AZ-a 종료 → AZ-c 시작 → 데이터 무손실
- [ ] EBS 분실 복구: EBS 수동 삭제 → 컨테이너 시작 → S3에서 자동 복원
- [ ] SSO/SAML 로그인: IdP 연동 → 첫 로그인 → 자동 계정 생성 + 부서 할당
- [ ] 3-tier 역할: admin/dept-manager/user 각각 로그인 → 권한별 화면/API 접근 제한
- [ ] 예산 스키마: DynamoDB 테이블 CRUD 정상 동작

## Phase 2: User Experience

- [ ] User Portal: 사용자 로그인 → 셀프서비스 컨테이너 시작/중지 → code-server 접속
- [ ] 승인 플로우: 신규 사용자 → 신청 → Dept Manager 승인 → 컨테이너 접근 가능
- [ ] 토큰 대시보드: 사용자/부서/admin 각각 실시간 토큰 사용량 표시
- [ ] 예산 초과 차단: 일일 한도 초과 → Bedrock API 호출 차단 + 알림
- [ ] EBS 증설: 사용자 요청 → 승인 → 온라인 리사이즈 → 재시작 없음

## Phase 3: Scale & Operations

- [ ] NLB + Nginx 라우팅: 200명 동시 접속 → Host 기반 라우팅 정상, WebSocket 안정
- [ ] Nginx config 동적 배포: 컨테이너 시작/종료 10회 반복 → 30초 내 reload
- [ ] Warm Stop: 45분 idle 시뮬레이션 → SNS 알림 → S3 sync → EBS snapshot → Task 중지
- [ ] Warm Resume: 같은 AZ <60초, 다른 AZ <3분
- [ ] Idle 감지 정확도: 빌드 실행 중 브라우저 닫기 → idle 판정 안 됨
- [ ] Keep Alive: 알림 링크 클릭 → 1시간 idle 타이머 리셋
- [ ] ECS 스케일링: 100→200명 급증 → ASG 5분 내 인스턴스 추가

## Phase 4: Hardening

- [ ] 부하 테스트: Locust 1000명 동시 → p99 <5초, 에러율 <1%
- [ ] 보안 리뷰: 이전 27개 이슈 전부 해결 확인
- [ ] 프롬프트 감사: Bedrock 100건 호출 → CloudTrail + DynamoDB 전건 기록
- [ ] 폐쇄망 테스트: 프록시만 허용 → Bedrock VPC Endpoint + npm 미러로 정상 동작
- [ ] DR 테스트: AZ-a 비활성 → AZ-c 전체 복구, S3에서 데이터 복원
- [ ] 비용 검증: 2주 운영 후 실제 비용 vs 추정 ±20% 이내
