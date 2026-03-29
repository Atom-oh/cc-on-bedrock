# CC-on-Bedrock 프로젝트 리뷰

검토일: 2026-03-29  
범위: 현재 워크트리 변경분 기준 정적 리뷰  
중점: 회귀 가능성, 동작 불일치, 권한/인프라 설정 오류, 테스트 공백

## 주요 발견사항

### High - 인증서 없는 배포 경로에서 ALB가 실제로는 막혀 있음

대시보드와 DevEnv ALB 모두 CloudFront Prefix List로 `443`만 열어두었는데, 인증서 ARN이 없을 때는 여전히 `HTTP :80` 리스너를 생성하도록 되어 있습니다. 이 경우 CloudFront는 원본(ALB)과 HTTP로 통신하려고 하지만, 정작 ALB 보안 그룹은 `80`을 허용하지 않으므로 트래픽이 차단됩니다.

즉, 코드 주석상으로는 “인증서 없으면 HTTP fallback 가능”처럼 보이지만 실제 배포 결과는 접근 불가입니다. 개발/테스트 환경에서 인증서 없이 올리면 바로 배포 장애로 이어질 수 있습니다.

참조:
- [cdk/lib/05-dashboard-stack.ts](/home/ec2-user/cc-on-bedrock/cdk/lib/05-dashboard-stack.ts#L121)
- [cdk/lib/05-dashboard-stack.ts](/home/ec2-user/cc-on-bedrock/cdk/lib/05-dashboard-stack.ts#L249)
- [cdk/lib/04-ecs-devenv-stack.ts](/home/ec2-user/cc-on-bedrock/cdk/lib/04-ecs-devenv-stack.ts#L322)
- [cdk/lib/04-ecs-devenv-stack.ts](/home/ec2-user/cc-on-bedrock/cdk/lib/04-ecs-devenv-stack.ts#L355)

영향:
- 인증서 미설정 환경에서 Dashboard 접속 실패 가능
- 인증서 미설정 환경에서 DevEnv 접속 실패 가능
- 코드 설명과 실제 네트워크 동작이 어긋나 운영자가 원인 파악하기 어려움

권장 수정:
- 인증서가 없을 때는 ALB SG에도 CloudFront Prefix List 기반 `80` 허용을 추가하거나
- 아예 인증서 없는 배포를 금지하고 synth/deploy 단계에서 실패시키는 쪽이 더 안전합니다

### High - 사용자 포털에서 시작한 컨테이너가 사용자별 storageType을 잃어버림

현재 프로젝트는 사용자마다 `storageType`을 다르게 가질 수 있는 구조입니다. 실제로 사용자 생성 시 `ebs`/`efs`를 선택하고 Cognito 속성에도 저장합니다. 관리자 화면에서 컨테이너를 시작할 때도 이 값을 전달합니다.

그런데 사용자 포털에서 직접 컨테이너를 시작하는 경로에서는 문제가 있습니다.

1. 세션 타입에 `storageType`이 없습니다.
2. NextAuth 세션 생성 시 `custom:storage_type`을 읽어오지 않습니다.
3. 사용자용 `/api/user/container` 시작 API에서 `startContainer()` 호출 시 `storageType`을 넘기지 않습니다.
4. 그러면 최종 ECS 태그에서는 기본값 `efs`가 들어갑니다.

즉, 관리자가 해당 사용자를 `ebs` 사용자로 만들어도 사용자가 포털에서 직접 시작한 컨테이너는 `efs`로 취급될 수 있습니다. 이건 스토리지 정책 불일치이고, 이후 EBS resize, keep-alive, lifecycle 같은 기능과 충돌할 가능성이 큽니다.

참조:
- [shared/nextjs-app/src/lib/types.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/types.ts#L3)
- [shared/nextjs-app/src/lib/auth.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/auth.ts#L17)
- [shared/nextjs-app/src/lib/auth.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/auth.ts#L55)
- [shared/nextjs-app/src/app/api/user/container/route.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/app/api/user/container/route.ts#L95)
- [shared/nextjs-app/src/lib/aws-clients.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/aws-clients.ts#L551)

영향:
- 사용자별 스토리지 정책이 self-service 경로에서 무시됨
- EBS 사용자가 실제로는 EFS로 시작될 수 있음
- 운영자가 사용자 속성과 실제 실행 컨테이너 상태를 다르게 보게 됨

권장 수정:
- `UserSession`에 `storageType` 추가
- NextAuth `jwt/session` 콜백에서 `custom:storage_type` 매핑
- `/api/user/container`에서 `startContainer()` 호출 시 `storageType` 전달

### High - EBS resize API가 사용자별 속성이 아니라 전역 환경변수로 동작을 결정함

이 부분이 가장 혼란을 만들 가능성이 큽니다.

프로젝트의 다른 부분은 이미 storage를 “사용자별 속성”으로 다루고 있습니다. 사용자 생성 시 `storageType`을 선택할 수 있고, 관리자 컨테이너 시작 경로도 그 값을 사용합니다. 즉 설계 의도는 사용자마다 `ebs` 또는 `efs`를 다르게 가질 수 있는 구조입니다.

그런데 EBS resize API는 로그인 사용자나 대상 사용자의 `storageType`을 보지 않고, 서버 전체의 `process.env.STORAGE_TYPE`만 확인합니다.

예를 들어 아래 코드처럼 전역 env가 `ebs`인지 여부만 보고 전체 API를 열거나 닫습니다.

참조:
- [shared/nextjs-app/src/app/api/user/ebs-resize/route.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/app/api/user/ebs-resize/route.ts#L16)
- [shared/nextjs-app/src/app/api/admin/ebs-resize/route.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/app/api/admin/ebs-resize/route.ts#L19)

이 설계가 왜 문제인지 예를 들면:

1. 전역 env가 `efs`이면
- 실제로는 `ebs` 사용자여도 resize API가 무조건 501로 막힙니다.

2. 전역 env가 `ebs`이면
- 실제로는 `efs` 사용자여도 EBS 전용 API가 열립니다.

3. 앞의 self-service storageType 유실 문제와 결합되면
- 사용자 속성은 `ebs`
- 실제 실행 컨테이너 태그는 `efs`
- 전역 env는 `ebs`
- 이렇게 세 기준이 서로 달라질 수 있습니다.

즉, “누가 EBS 사용자냐”에 대한 판정 기준이 코드베이스 안에서 하나로 통일되어 있지 않습니다.

추가 참조:
- [shared/nextjs-app/src/app/admin/user-management.tsx](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/app/admin/user-management.tsx#L23)
- [shared/nextjs-app/src/app/admin/containers/container-management.tsx](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/app/admin/containers/container-management.tsx#L73)

영향:
- 실제 EBS 사용자가 resize를 못 하는 오동작
- 실제 EFS 사용자에게 EBS 관련 UI/API가 노출되는 불일치
- 장애가 나도 원인이 사용자 속성인지, env인지, 실제 컨테이너 태그인지 혼재되어 디버깅 난이도 상승

권장 수정:
- 전역 `STORAGE_TYPE`로 게이트하지 말고 현재 사용자 또는 대상 사용자의 `storageType`을 조회해서 판정
- 관리자 API는 대상 사용자 기준으로 판정
- 사용자 API는 세션의 `storageType` 또는 사용자 조회 결과 기준으로 판정
- 컨테이너 태그와 사용자 속성 사이 불일치도 함께 정리 필요

### Medium - 컨테이너 메트릭 차트가 시간축과 값을 잘못 짝지을 수 있음

새로 추가된 `getTaskMetrics()`는 CPU 시계열의 timestamp 배열을 기준으로 메모리/네트워크 값을 같은 인덱스로 끼워 넣고 있습니다. 그런데 CloudWatch `GetMetricData`는 각 메트릭의 timestamp 집합이 항상 완전히 같다고 보장되지 않습니다. 특정 시점 데이터가 일부 메트릭에서만 빠지면, 현재 구현은 값이 다른 시각에 잘못 매핑된 차트를 만들 수 있습니다.

이 문제는 서버 에러처럼 드러나지 않고, 겉보기에 정상처럼 보이는 잘못된 차트를 만들 수 있어서 더 위험합니다.

참조:
- [shared/nextjs-app/src/lib/cloudwatch-client.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/cloudwatch-client.ts#L193)
- [shared/nextjs-app/src/lib/cloudwatch-client.ts](/home/ec2-user/cc-on-bedrock/shared/nextjs-app/src/lib/cloudwatch-client.ts#L205)

영향:
- CPU/메모리/네트워크 차트가 실제와 다른 추세로 보일 수 있음
- 운영자가 특정 시점 부하를 잘못 해석할 수 있음

권장 수정:
- metric별 timestamp를 기준으로 map을 만든 뒤 공통 축으로 정렬해서 합치기
- 또는 CloudWatch metric math / 동일 타임슬롯 정규화를 적용

## 보조 메모

- 이번 리뷰는 정적 분석만 수행했습니다.
- `next build`, `next lint`, CDK synth, 배포 검증 테스트는 이번 패스에 포함하지 않았습니다.
- 특히 위 High 이슈들은 코드상 재현 가능성이 높으므로 실제 수정 전후로 간단한 시나리오 테스트를 붙이는 것이 좋습니다.
