# Next.js Dashboard Module

## Role
관리자/사용자 대시보드: 사용량 분석, 모니터링, EC2 DevEnv 관리, 셀프서비스 포털, AI Assistant, 보안, Local Governance Mode. Terraform `modules/dashboard`의 EC2 ASG에서 컨테이너로 실행된다. 페이지·API·lib 전체 목록은 `shared/nextjs-app/CLAUDE.md`.

## Main areas
- `/` Home, `/user` 셀프서비스 포털, `/dept` 부서 관리자, `/analytics`, `/monitoring`, `/security`, `/ai`
- `/admin` (users, instances, budgets, tokens, approvals, dlp, mcp, limits), `/local` (Local Mode 자격증명), `/docs`
- API: `src/app/api/` 아래 admin / user / local / ai / dept / install / slack route

## Key Libs
- `src/lib/auth.ts` - Cognito + NextAuth (8h JWT 세션)
- `src/lib/ec2-clients.ts` - EC2 DevEnv 수명주기, UserData
- `src/lib/usage-client.ts` - DynamoDB `cc-on-bedrock-usage` 기반 사용량 조회
- `src/lib/aws-clients.ts` - Cognito, DynamoDB 라우팅 테이블
- `src/lib/iam-request-validation.ts` - IAM 권한 신청 검증 (ADR-007)
- `src/lib/i18n.tsx` - 한/영

## Rules
- Server Components가 기본이고, 차트/인터랙티브 UI만 `'use client'`.
- 모든 API route는 세션을 검증한다. Admin 페이지/route는 Cognito `admin` 그룹, user route는 본인 데이터만.
- Bedrock 사용량은 DynamoDB에서 읽는다 (CloudWatch `AWS/Bedrock`은 계정 전체 수치).
- 검증: `npx tsc --noEmit`, `npx vitest run`.
