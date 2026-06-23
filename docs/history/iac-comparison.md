# IaC 도구 비교 가이드: CDK vs Terraform vs CloudFormation

CC-on-Bedrock 프로젝트는 동일한 아키텍처를 3가지 IaC(Infrastructure as Code) 도구로 구현했습니다.
이 문서에서는 각 도구의 특성을 비교하고, 상황별 권장 도구를 안내합니다.

---

## 기능 비교표

| 항목 | CDK (TypeScript) | Terraform (HCL) | CloudFormation (YAML) |
|------|:-:|:-:|:-:|
| **언어** | TypeScript | HCL | YAML |
| **추상화 수준** | L2/L3 Construct (고수준) | Resource 기반 (중수준) | Resource 기반 (저수준) |
| **상태 관리** | CloudFormation Stack | terraform.tfstate | CloudFormation Stack |
| **멀티 클라우드** | AWS 전용 | AWS, GCP, Azure 등 | AWS 전용 |
| **프로그래밍 가능** | O (TypeScript 풀 기능) | 제한적 (HCL 함수) | 제한적 (Intrinsic Functions) |
| **타입 안전성** | O (TypeScript) | 제한적 | X |
| **드라이 런** | `cdk diff` | `terraform plan` | Change Set |
| **모듈화** | Stack + Construct | Module | Nested Stack |
| **리팩토링** | IDE 지원 (변수명, 인터페이스) | 수동 | 수동 |
| **테스트** | Jest/Mocha 유닛 테스트 | terraform test (HCL) | cfn-lint + TaskCat |
| **학습 곡선** | 중간 (TypeScript + AWS 지식) | 낮음 (HCL 문법 직관적) | 높음 (YAML 장황함) |
| **생태계** | npm (Construct Hub) | Terraform Registry | AWS 공식 문서 |
| **롤백** | CloudFormation 자동 롤백 | 수동 (terraform apply 재실행) | 자동 롤백 |
| **크로스 리전 리소스** | O (Stack 분리) | O (Provider alias) | X (별도 스택 필요) |
| **시크릿 관리** | SecretValue 타입 | sensitive 변수 | NoEcho 파라미터 |

---

## 프로젝트 코드 구조 비교

### CDK (TypeScript)

```
cdk/
  bin/app.ts              # 엔트리포인트, 스택 조립
  config/default.ts       # 타입 안전한 설정값
  lib/
    01-network-stack.ts   # Stack 클래스 (L2 Construct 활용)
    02-security-stack.ts
    03-litellm-stack.ts
    04-ecs-devenv-stack.ts
    05-dashboard-stack.ts
  package.json
  tsconfig.json
```

**특징**:
- `app.ts`에서 Stack 간 의존성을 타입 안전하게 전달 (예: `networkStack.vpc`)
- L2 Construct가 Security Group, IAM Policy 등을 자동 생성
- `CcOnBedrockConfig` 인터페이스로 설정값 타입 보장

### Terraform (HCL)

```
terraform/
  main.tf                  # 루트 모듈, 5개 모듈 조립
  variables.tf             # 입력 변수 정의
  outputs.tf               # 출력값 정의
  providers.tf             # AWS Provider 설정
  terraform.tfvars.example # 설정값 예시
  modules/
    network/
      main.tf / variables.tf / outputs.tf
    security/
      main.tf / variables.tf / outputs.tf
    litellm/
      main.tf / variables.tf / outputs.tf
    ecs-devenv/
      main.tf / variables.tf / outputs.tf
    dashboard/
      main.tf / variables.tf / outputs.tf
```

**특징**:
- 모듈 간 의존성을 `module.network.vpc_id`로 명시적 전달
- `variables.tf` + `outputs.tf`가 모듈의 인터페이스 역할
- `terraform plan`으로 변경사항 미리 확인 가능

### CloudFormation (YAML)

```
cloudformation/
  01-network.yaml          # 독립 템플릿
  02-security.yaml
  03-litellm.yaml
  04-ecs-devenv.yaml
  05-dashboard.yaml
  deploy.sh                # 순차 배포 + 출력값 전달 스크립트
  destroy.sh               # 역순 삭제 스크립트
  params/
    default.json           # 파라미터 기본값
```

**특징**:
- 각 템플릿이 완전히 독립적 (bash 스크립트가 출력값을 전달)
- YAML로 모든 리소스를 명시적 선언
- `deploy.sh`가 스택 간 오케스트레이션 담당

---

## 장단점 비교

### CDK (TypeScript)

**장점**:
- 고수준 추상화 (예: `ec2.Vpc`는 서브넷, 라우트 테이블, NAT 자동 생성)
- TypeScript의 타입 시스템으로 설정 오류 컴파일 타임에 감지
- IDE 자동완성, 리팩토링 지원
- 반복 리소스 생성 시 `for` 루프, 조건문 자유롭게 사용
- Construct Hub에서 커뮤니티 패턴 재사용
- CloudFormation 위에 구축되어 자동 롤백 지원

**단점**:
- CDK Bootstrap 사전 설정 필요 (`CDKToolkit` 스택)
- L2 Construct가 생성하는 리소스가 불투명할 수 있음 (예: 자동 생성되는 SG 규칙)
- CloudFormation 변환 과정에서 디버깅이 어려울 수 있음
- TypeScript 빌드 과정 필요 (`tsc` → CloudFormation JSON)
- 팀에 TypeScript 경험이 없으면 학습 비용 발생

### Terraform (HCL)

**장점**:
- HCL 문법이 직관적이고 가독성 우수
- `terraform plan`으로 변경사항 상세 미리보기
- 상태 파일(tfstate)로 정확한 리소스 추적
- 멀티 클라우드 지원 (AWS 외 다른 클라우드로 확장 가능)
- Terraform Registry의 풍부한 모듈 생태계
- HCL은 선언형이면서도 `for_each`, `dynamic` 블록 등 유연함 제공

**단점**:
- 상태 파일 관리가 필요 (S3 백엔드 권장, 로컬 tfstate 분실 위험)
- 자동 롤백 없음 (실패 시 수동 복구)
- 크로스 리전 리소스(ACM us-east-1)에 Provider alias 설정 필요
- HCL의 프로그래밍 기능은 TypeScript 대비 제한적
- 상태 파일 잠금(Lock) 관리 (팀 작업 시 DynamoDB 필요)

### CloudFormation (YAML)

**장점**:
- AWS 네이티브 (추가 도구 설치 불필요)
- 자동 롤백 + 드리프트 감지 기본 지원
- 모든 AWS 서비스 Day-1 지원 (신규 서비스 즉시 사용 가능)
- Change Set으로 변경사항 미리 확인
- StackSets로 멀티 계정/리전 배포 지원
- 별도 상태 관리 불필요 (CloudFormation이 관리)

**단점**:
- YAML이 장황함 (동일 인프라 코드 줄 수가 CDK 대비 3-5배)
- 프로그래밍 기능 극히 제한적 (Conditions, Fn::If 정도)
- 스택 간 출력값 전달이 번거로움 (Export/Import 또는 스크립트 필요)
- 복잡한 조건부 리소스 생성이 어려움
- 에러 메시지가 불친절한 경우 있음
- 리팩토링이 어려움 (리소스 이름 변경 시 교체 발생 가능)

---

## 상황별 권장 도구

### CDK를 선택해야 하는 경우

- 팀에 TypeScript/JavaScript 경험자가 있는 경우
- 복잡한 조건부 로직이 필요한 경우 (환경별 설정, 피처 플래그 등)
- 유닛 테스트로 인프라 코드 품질을 관리하고 싶은 경우
- AWS 전용 환경이며 높은 추상화 수준이 필요한 경우
- Construct Hub의 재사용 가능한 패턴을 활용하고 싶은 경우

### Terraform을 선택해야 하는 경우

- 멀티 클라우드 전략이 있는 경우 (AWS + GCP/Azure)
- `terraform plan`의 상세한 변경 미리보기가 중요한 경우
- 팀이 HCL에 익숙하거나 Terraform Registry 모듈을 많이 사용하는 경우
- AWS 외의 SaaS 리소스(GitHub, Datadog 등)도 함께 관리하는 경우
- 클라우드 엔지니어 중심 팀 (개발자 중심이 아닌)

### CloudFormation을 선택해야 하는 경우

- AWS 공식 지원/서포트가 중요한 경우
- 추가 도구 설치가 제한된 환경 (AWS CLI만 사용 가능)
- StackSets로 멀티 계정/리전 배포가 필요한 경우
- AWS 신규 서비스를 Day-1에 사용해야 하는 경우
- 조직의 표준이 CloudFormation인 경우

---

## 배포 경험 비교

### 초기 설정

| 단계 | CDK | Terraform | CloudFormation |
|------|-----|-----------|----------------|
| 도구 설치 | `npm i -g aws-cdk` | terraform 바이너리 다운로드 | 불필요 (AWS CLI) |
| 초기화 | `cdk bootstrap` | `terraform init` | 불필요 |
| 설정 파일 | `config/default.ts` | `terraform.tfvars` | `params/default.json` |
| 총 소요 시간 | ~5분 | ~3분 | ~1분 |

### 배포 실행

| 단계 | CDK | Terraform | CloudFormation |
|------|-----|-----------|----------------|
| 명령어 | `cdk deploy --all` | `terraform apply` | `bash deploy.sh` |
| 미리보기 | `cdk diff` | `terraform plan` | Change Set |
| 병렬 배포 | Stack 의존성 자동 | Provider 수준 병렬 | 스크립트로 순차 |
| 예상 소요 시간 | ~25-35분 | ~25-35분 | ~30-40분 |
| 롤백 | 자동 | 수동 | 자동 |

### 일상 운영

| 작업 | CDK | Terraform | CloudFormation |
|------|-----|-----------|----------------|
| 설정 변경 | `.ts` 수정 -> `cdk deploy` | `.tf` 수정 -> `terraform apply` | `.yaml` 수정 -> `deploy.sh` |
| 드리프트 감지 | CloudFormation 드리프트 | `terraform plan` (자동) | CloudFormation 드리프트 |
| 상태 확인 | CloudFormation 콘솔 | `terraform show` | CloudFormation 콘솔 |
| 삭제 | `cdk destroy --all` | `terraform destroy` | `bash destroy.sh` |

---

## CC-on-Bedrock 프로젝트에서의 코드 비교 예시

### VPC 생성

**CDK** (약 15줄):
```typescript
const vpc = new ec2.Vpc(this, 'Vpc', {
  vpcName: config.vpcName,
  ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
  maxAzs: 2,
  natGateways: 2,
  subnetConfiguration: [
    { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
    { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 23 },
  ],
});
// Route Table, NAT Gateway, Internet Gateway 자동 생성
```

**Terraform** (약 60줄):
```hcl
resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr
  tags       = { Name = var.vpc_name }
}
resource "aws_subnet" "public_a" { ... }
resource "aws_subnet" "public_c" { ... }
resource "aws_nat_gateway" "a" { ... }
resource "aws_nat_gateway" "c" { ... }
resource "aws_route_table" "private" { ... }
// 각 리소스를 명시적으로 선언
```

**CloudFormation** (약 120줄):
```yaml
Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      Tags: [{ Key: Name, Value: !Ref VpcName }]
  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties: ...
  NatGatewayA:
    Type: AWS::EC2::NatGateway
    Properties: ...
  # 각 리소스를 개별적으로 선언하며, YAML 문법으로 장황해짐
```

---

## 결론

CC-on-Bedrock 프로젝트에서 3가지 IaC 도구를 모두 제공하는 이유:

1. **교육 목적**: 동일한 아키텍처를 다른 도구로 구현한 코드를 비교하며 학습
2. **조직 유연성**: 팀의 기존 도구 경험에 맞춰 선택 가능
3. **레퍼런스**: AWS 인프라 설계 패턴의 멀티-IaC 레퍼런스 자료

일반적인 권장사항:
- **새 팀/프로젝트**: CDK (TypeScript) - 생산성과 타입 안전성
- **기존 Terraform 팀**: Terraform - 기존 경험 활용
- **AWS 표준 준수**: CloudFormation - 네이티브 지원
