# ADR-011: Bedrock IAM Cost Allocation Hybrid Integration

## Status
Accepted (2026-04-10)

## Context
AWS announced Bedrock IAM principal-based cost allocation on 2026-04-09, enabling native per-IAM-role cost tracking in CUR 2.0 and Cost Explorer. CC-on-Bedrock already uses per-user IAM roles (`cc-on-bedrock-task-{subdomain}`) for Bedrock access control and budget enforcement.

The question: should we replace the custom cost tracking system (Lambda + DynamoDB) with native AWS billing, or keep both?

## Decision
**Hybrid approach**: Keep existing custom system, add native AWS cost allocation as a supplementary channel.

### Rationale

| Dimension | Custom (Lambda+DynamoDB) | Native (CUR 2.0+Cost Explorer) |
|-----------|--------------------------|-------------------------------|
| Latency | ~seconds | ~24 hours |
| Budget enforcement | 5-min cycle (IAM Deny) | 8-12 hours (AWS Budgets) |
| Token granularity | input/output tokens, latency | Dollar amounts only |
| Cost accuracy | Hardcoded pricing estimates | Actual AWS billing |
| Management reporting | Custom dashboard needed | Cost Explorer native |

Native billing alone cannot support the 5-minute budget enforcement cycle required for a multi-tenant development platform. However, native billing provides authoritative cost data for financial reporting and reconciliation.

## Changes
1. **IAM role tags**: Added `username`, `department`, `project` tags to per-user roles for cost allocation
2. **Tag sync on reuse**: Existing roles get tags updated on each container start
3. **Migration script**: One-time script to tag existing roles (`scripts/migrate-role-tags.sh`)
4. **CUR 2.0 export**: CDK resource for CUR 2.0 Data Export with `INCLUDE_CALLER_IDENTITY: TRUE`
5. **S3 bucket**: `cc-on-bedrock-cost-reports-{accountId}` for CUR 2.0 Parquet data

## What stays the same
- `bedrock-usage-tracker.py` Lambda (real-time token tracking)
- `budget-check.py` Lambda (5-min budget enforcement)
- DynamoDB tables (dashboard data source)
- IAM Deny Policy dynamic attachment (instant blocking)
- Next.js analytics dashboard

## Future work (not in this ADR)
- Phase 3: Dashboard cost reconciliation (estimated vs actual)
- Phase 4: AWS Budgets native per-department alerts, Cost Anomaly Detection

## Implementation Status

| 구성요소 | 상태 | 구현 위치 |
|---------|------|---------|
| IAM role 태그 (username, department, project) | **구현** | `ec2-clients.ts` — `ensureUserInstanceProfile()` |
| Tag sync on reuse | **구현** | `ec2-clients.ts` — `TagRoleCommand` on existing roles |
| EC2 instance 태그 | **구현** | `ec2-clients.ts` — RunInstances Tags |
| CUR 2.0 Data Export | **보류** | AWS BCM Data Exports API에 `INCLUDE_CALLER_IDENTITY` 미지원 |
| S3 cost-reports 버킷 | **보류** | CUR 2.0 보류에 따라 미생성 |

## Consequences
- Small additional IAM API call (`TagRole`) on each container start — negligible latency
- Cost allocation tags must be manually activated in AWS Billing console
- CUR 2.0 data arrives ~24h after API calls — not suitable for real-time dashboards
- S3 storage for CUR 2.0 reports (~minimal cost, Parquet format, 365-day lifecycle)
