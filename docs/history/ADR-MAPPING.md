# ADR Mapping — legacy ADR-NNN → consolidated 0NN

> The legacy ADRs (ADR-001..034) were consolidated into 11 baseline ADRs on 2026-06-23.
> **Legacy bodies are NOT in the tree** — retrieve with `git show adr-legacy-2026-06-23:docs/decisions/ADR-NNN-<slug>.md`.
> Current truth: `docs/decisions/BASELINE.md` + the consolidated `docs/decisions/0NN-*.md`.
> Brainstorming-misclassified items live (as bodies) under `docs/history/brainstorm/`.

| Legacy ADR | → | Consolidated / disposition |
|---|---|---|
| ADR-001 EBS+S3 storage | → | **002** DevEnv compute·storage (superseded) |
| ADR-002 NLB+nginx routing | → | **003** access topology·routing |
| ADR-003 ECS host-attach EBS | → | **002** (superseded) |
| ADR-004 EC2-per-user DevEnv | → | **002** |
| ADR-005 Security policy + IAM | → | **007** IAM access control (DLP 3-tier + IAM; catalog superseded by 030) |
| ADR-006 Dept budget mgmt | → | **008** budget enforcement |
| ADR-007 Dept MCP Gateway | → | **history/brainstorm/** (out-of-scope) |
| ADR-008 Enterprise SSO | → | **history/brainstorm/** (deferred) |
| ADR-009 DevEnv multi-port routing | → | **003** |
| ADR-010 EC2 hibernation | → | **002** |
| ADR-011 Bedrock IAM cost allocation | → | **005** usage metering |
| ADR-012 DevEnv Cognito auth (Lambda@Edge) | → | **004** auth (superseded) |
| ADR-013 Unified CloudFront | → | **003** (superseded) |
| ADR-014 Local Governance Mode | → | **006** shared credentials |
| ADR-015 Budget × token integration | → | **008** |
| ADR-016 CloudFront split | → | **003** |
| ADR-017 Dashboard rolling deployment | → | **011** dashboard deploy |
| ADR-018 Dual-OS AMI | → | **002** |
| ADR-019 Model ID normalization | → | **005** |
| ADR-020 Runtime IAM policy upsert | → | **007** |
| ADR-021 Wildcard Claude IAM | → | **007** |
| ADR-022 EventBridge pre-provisioning | → | **010** provisioning |
| ADR-023 Dept per-user budget default | → | **008** |
| ADR-024 Cognito deletion cleanup | → | **004** |
| ADR-025 Canonical id = Cognito sub | → | **005** (superseded by 031→005) |
| ADR-026 IAM grant service-ceiling | → | **007** (superseded by 030) |
| ADR-027 DevEnv custom port exposure | → | **003** |
| ADR-028 Cognito trigger fallback provisioning | → | **010** (also ref'd by 004) |
| ADR-029 Local Mode credential_process | → | **006** |
| ADR-029-usage (duplicate of 031) | → | **005** (was a renumber leftover) |
| ADR-030 Tiered IAM grant + boundary X | → | **007** |
| ADR-031 usage email canonical key | → | **005** |
| ADR-032 Persistent data EBS (2-volume) | → | **002** |
| ADR-033 CDK→Terraform migration | → | **001** IaC: Terraform |
| ADR-034 Permission boundary in Terraform | → | **007** (amends 030 §T3) |
| OTel productivity-monitoring (design spec) | → | **009** OTel observability (formalized) |
