# ADR-010: EC2 Hibernation for DevEnv Instances

## Status
Accepted (Phase 4 — HIBERNATE_ENABLED=true 전환 완료 2026-04-16)

## Context

CC-on-Bedrock의 EC2-per-user DevEnv 아키텍처(ADR-004)에서 사용자가 인스턴스를 Stop/Start할 때 code-server 세션, 열린 파일 탭, 터미널 히스토리, 실행 중인 프로세스 등 모든 메모리 상태를 잃는다. Start 시 UserData 재실행, code-server 재시작, CloudWatch Agent 재초기화가 필요하며 완전 복구까지 30-60초가 소요된다.

현재 Stop이 발생하는 3가지 경로:
1. **사용자 직접 Stop**: User Portal → `stopInstance()` → `StopInstancesCommand`
2. **유휴 자동 Stop**: `ec2-idle-stop.py` Lambda (45분 유휴 시) → `ec2.stop_instances()`
3. **EOD 일괄 Stop**: 같은 Lambda (18:00 KST) → 동일

AWS EC2 Hibernation은 RAM 내용을 암호화된 EBS 루트 볼륨에 저장하고, Start 시 메모리를 복원하여 프로세스 상태를 즉시 재개한다. 비용은 일반 Stop과 동일(EBS 과금만 발생).

### 현재 인프라 Hibernate 적합성

| 요구사항 | 현재 상태 | 충족 여부 |
|----------|----------|-----------|
| 인스턴스 타입 | t4g.medium/large, m7g.xlarge (Graviton ARM64) | ✅ 지원됨 |
| EBS 루트 암호화 | GP3 30GB, `encrypted: true` | ✅ 필수 조건 충족 |
| 루트 볼륨 >= RAM | 30GB >> 16GiB (m7g.xlarge 최대) | ✅ 충분 |
| Linux RAM < 150GiB | 최대 16GiB | ✅ 범위 내 |
| Auto Scaling Group 미사용 | EC2-per-user (ASG 없음) | ✅ 해당 없음 |
| Hibernation Agent | **미설치** | ❌ AMI 업데이트 필요 |
| Ubuntu 24.04 ARM64 공식 지원 | **미기재** (AWS 문서에 22.04까지만 명시) | ⚠️ 수동 검증 필요 |

## Options Considered

### Option 1: 현행 유지 (Stop/Start)
- 변경 없음. Stop → Start 시 30-60초 부팅 + 상태 손실
- **Pros**: 코드 변경 없음, 위험 없음
- **Cons**: 사용자 경험 열악, code-server 세션/터미널 히스토리 매번 유실

### Option 2: EC2 Hibernation (Feature Flag + Graceful Fallback)
- Stop 시 `Hibernate=true` 파라미터 추가, Start 시 메모리 즉시 복원
- Feature flag(`HIBERNATE_ENABLED`)로 점진적 활성화
- per-instance `HibernationOptions.Configured` 확인으로 구형 인스턴스 하위호환
- Hibernate 실패 시 자동으로 일반 Stop fallback
- **Pros**: 즉시 재개(~5초), 세션 보존, 비용 동일, 점진적 rollout
- **Cons**: AMI 업데이트 필요, Ubuntu 24.04 지원 미확인, 60일 제한 rotation 필요

### Option 3: CRIU (Checkpoint/Restore In Userspace)
- 애플리케이션 레벨 checkpoint/restore
- **Pros**: OS/AWS 의존성 없음
- **Cons**: code-server/Node.js/Python 프로세스 전체 CRIU 호환성 미검증, 구현 복잡도 극히 높음, 유지보수 부담

## Decision

**Option 2: EC2 Hibernation (Feature Flag + Graceful Fallback)**

### Reasoning

1. **UX 핵심 개선**: Stop→Start 30-60초 + 상태 손실 → Hibernate→Resume ~5초 + 완전 복원. 하루 2-3회 Stop/Start하는 사용자에게 실질적 생산성 향상.
2. **비용 동일**: Hibernate 상태는 Stop과 동일하게 컴퓨팅 과금 없음. EBS 과금만 발생하며 이미 `deleteOnTermination: false`로 Stop 시에도 EBS를 유지하고 있음.
3. **인프라 사전 충족**: EBS 암호화, GP3 볼륨, Graviton 인스턴스 타입 모두 이미 Hibernate 요구사항을 충족.
4. **안전한 rollout**: Feature flag + per-instance capability check + 실패 시 fallback으로 기존 인스턴스에 영향 없이 점진적 적용 가능.
5. **CRIU 대비 단순함**: OS 레벨 기능이므로 애플리케이션 수정 불필요. code-server, Claude Code CLI, Kiro CLI 등 모든 프로세스가 투명하게 복원됨.

### 핵심 제약사항

| 제약 | 대응 |
|------|------|
| **Launch 시점에만 활성화 가능** | 기존 인스턴스는 일반 Stop, 신규 인스턴스만 Hibernate 가능 |
| **Hibernate 상태에서 인스턴스 타입 변경 불가** | `changeTier()`는 반드시 `Hibernate: false`로 일반 Stop |
| **최대 60일 Hibernate 제한** | 55일 도달 시 자동 Start→Re-Hibernate rotation |
| **Ubuntu 24.04 공식 지원 미확인** | Phase 0 수동 검증 후 결정. 실패 시 AL2023 전환 검토 |

### Stop 경로별 동작

| 경로 | 현재 | 변경 후 | Hibernate 사용 |
|------|------|---------|----------------|
| 사용자 Stop | `StopInstances` | `StopInstances(Hibernate=true)` | ✅ Yes |
| 유휴 자동 Stop | `stop_instances()` | `stop_instances(Hibernate=True)` | ✅ Yes |
| EOD 일괄 Stop | `stop_instances()` | `stop_instances(Hibernate=True)` | ✅ Yes |
| changeTier (리사이즈) | `StopInstances` | `StopInstances(Hibernate=false)` | ❌ No (타입 변경 필요) |
| switchOs (OS 전환) | `StopInstances` | `StopInstances(Hibernate=false)` | ❌ No (terminate+recreate) |

### 수정 대상 파일

| 파일 | 변경 |
|------|------|
| `scripts/build-ami.sh` | `ec2-hibinit-agent` 설치, KASLR 비활성화 |
| `cdk/lib/07-ec2-devenv-stack.ts` | Launch Template `hibernationConfigured: true` |
| `cdk/lib/03-usage-tracking-stack.ts` | Lambda 환경변수 + 60일 rotation EventBridge rule |
| `shared/nextjs-app/src/lib/ec2-clients.ts` | Feature flag, `HibernationOptions`, `isHibernateCapable()`, fallback |
| `cdk/lib/lambda/ec2-idle-stop.py` | Hibernate stop + 60일 rotation 액션 |
| `shared/nextjs-app/src/components/user/environment-tab.tsx` | HIBERNATED 상태 UI |
| `shared/nextjs-app/src/app/api/user/container/route.ts` | 상태 매핑 |

### Rollout 순서

1. **Phase 0**: Ubuntu 24.04 ARM64 + Hibernate 수동 검증 (BLOCKING) — ✅ 완료 2026-04-16
2. **Phase 1**: AMI 빌드 (`ec2-hibinit-agent` + KASLR) → SSM param 업데이트 — ✅ 완료 (build-ami.sh)
3. **Phase 2**: CDK + 앱 코드 배포 (`HIBERNATE_ENABLED=false` — 코드만 배포, 비활성) — ✅ 완료
4. **Phase 3**: 테스트 인스턴스에서 `HIBERNATE_ENABLED=true` 수동 검증 — ✅ Phase 0에서 통합 검증
5. **Phase 4**: 전체 `HIBERNATE_ENABLED=true` 전환 — ✅ 완료 2026-04-16 (Stack 03 + Stack 05)
6. **Phase 5**: UI 업데이트 (HIBERNATED 상태 표시) — ✅ 완료 (environment-tab.tsx, container route)

## Consequences

### Positive
- 사용자가 Stop/Start 시 code-server 세션, 터미널, 실행 중 프로세스를 완전 보존
- Resume 시간 ~5초 (기존 30-60초에서 대폭 단축)
- 비용 증가 없음 (Stop과 동일한 과금 구조)
- Feature flag로 인스턴스별 점진적 적용, 롤백 용이
- 유휴 자동 Stop 정책과 완벽 호환 (Hibernate 후에도 컴퓨팅 과금 중단)

### Negative
- AMI 업데이트 필요 (hibernation agent + KASLR 비활성화)
- 기존 실행 중 인스턴스는 Terminate+Recreate 전까지 Hibernate 불가 (Launch 시점 설정)
- 60일 Hibernate 제한으로 rotation Lambda 필요 (Start→Re-Hibernate 사이클)
- Hibernate 상태에서 인스턴스 타입 변경(changeTier) 불가 → 일반 Stop 필요 (자동 처리)

### Phase 0 검증 결과 (2026-04-16)

**환경**: t4g.large + Ubuntu 24.04 ARM64 (ami-071fb435e51ab8763) + GP3 30GB encrypted

| 항목 | 결과 |
|------|------|
| ec2-hibinit-agent 설치 | OK — swap offset 자동 설정 |
| GRUB nokaslr + resume_offset | OK — 커널 파라미터 적용 확인 |
| HibernationOptions.Configured | true (IMDS 확인) |
| Hibernate → Stop 전환 | OK — 에러 없음 |
| Resume → Running 전환 | OK — 에러 없음 |
| 파일시스템 보존 | OK — /home/ubuntu/ 마커 파일 보존 확인 |
| 백그라운드 프로세스 보존 | OK — tick 로그 168건 기록 확인 |
| hibernate.target 트리거 | OK — resume 시 systemd 서비스 실행 확인 |
| **SSM Agent 재연결** | **FAIL** — snap/deb 모두 실패, reboot 필요 |

**SSM 재연결 문제 대응**:
- snap SSM agent → deb 패키지로 교체 (snap confinement 관련 추가 이슈 방지)
- hibernate.target 기반 restart hook 설치 (SSM + CloudWatch + code-server)
- SSM 재연결은 관리 채널 문제로, 사용자 UX(code-server 8080)에는 영향 없음
- 필요 시 Dashboard API에서 `rebootInstances` 호출로 SSM 복구 가능

## References
- AWS EC2 Hibernation: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-hibernate-overview.html
- EC2-per-user 아키텍처: ADR-004
- 현재 인스턴스 관리: `shared/nextjs-app/src/lib/ec2-clients.ts`
- 유휴 자동 Stop: `cdk/lib/lambda/ec2-idle-stop.py`
- AMI 빌드: `scripts/build-ami.sh`
- Launch Template: `cdk/lib/07-ec2-devenv-stack.ts`
