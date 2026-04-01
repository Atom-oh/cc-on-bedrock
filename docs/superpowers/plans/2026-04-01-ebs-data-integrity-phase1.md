# EBS Data Integrity Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EBS orphan 볼륨 제거, snapshot 실패 시 데이터 손실 경고, DDB 스키마 통일, UI assigned 상태 반영

**Architecture:** 기존 ECS managed EBS volume 구조 유지. `deleteOnTermination: true`로 전환하여 orphan 제거. snapshot Lambda 호출을 동기로 변경하여 경쟁 조건 해결. DDB 필드명을 snake_case로 표준화.

**Tech Stack:** TypeScript (Next.js API routes), Python (Lambda), React (environment-tab)

**Spec:** `docs/superpowers/specs/2026-04-01-ebs-data-integrity-design.md`

---

### File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `shared/nextjs-app/src/lib/aws-clients.ts:678-694,728-734,900-916,950-956` | EBS snapshot 조회 경고 + deleteOnTermination + DDB 필드명 |
| Modify | `shared/nextjs-app/src/app/api/user/container/route.ts:195-217` | Stop 시 snapshot Lambda 동기 호출 + warning 응답 |
| Modify | `shared/nextjs-app/src/app/api/user/container/stream/route.ts:136-148` | snapshot 실패 SSE 경고 이벤트 전달 |
| Modify | `cdk/lib/lambda/ebs-lifecycle.py:199-212` | ECS-managed 태그 검사 제거, NotFound 정상 처리 |
| Modify | `shared/nextjs-app/src/components/user/environment-tab.tsx:125` | assigned 상태 매핑 |

---

### Task 1: EBS lifecycle Lambda — ECS-managed 삭제 로직 단순화

**Files:**
- Modify: `cdk/lib/lambda/ebs-lifecycle.py:199-212`

- [ ] **Step 1: Modify snapshot_and_detach volume deletion logic**

`cdk/lib/lambda/ebs-lifecycle.py` — lines 199-212의 ECS-managed 태그 검사를 제거하고, `InvalidVolume.NotFound`를 정상 처리로 변경:

```python
    logger.info(f"Snapshot {snapshot_id} completed, deleting volume {volume_id}")

    # Delete volume — may already be gone if ECS deleteOnTermination=true
    try:
        ec2.delete_volume(VolumeId=volume_id)
        logger.info(f"Deleted volume {volume_id}")
    except ClientError as e:
        if e.response["Error"]["Code"] == "InvalidVolume.NotFound":
            logger.info(f"Volume {volume_id} already deleted (ECS deleteOnTermination)")
        else:
            logger.warning(f"Volume {volume_id} deletion failed: {e}")
```

이 코드가 대체하는 기존 코드 (lines 199-212):
```python
    # 삭제 대상:
    logger.info(f"Snapshot {snapshot_id} completed, checking if volume is ECS-managed")
    try:
        vol_tags = ec2.describe_volumes(VolumeIds=[volume_id])["Volumes"][0].get("Tags", [])
        ecs_managed = any(t["Key"] in ("AmazonECSCreated", "AmazonECSManaged") for t in vol_tags)
        if ecs_managed:
            logger.info(f"Volume {volume_id} is ECS-managed, skipping deletion (ECS handles lifecycle)")
        else:
            ec2.delete_volume(VolumeId=volume_id)
            logger.info(f"Deleted volume {volume_id}")
    except Exception as e:
        logger.warning(f"Volume {volume_id} deletion skipped: {e}")
```

- [ ] **Step 2: Verify Lambda syntax**

Run: `cd /home/ec2-user/cc-on-bedrock && python3 -c "import ast; ast.parse(open('cdk/lib/lambda/ebs-lifecycle.py').read()); print('OK')"`

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add cdk/lib/lambda/ebs-lifecycle.py
git commit -m "fix: simplify EBS lifecycle — remove ECS-managed tag check, handle NotFound"
```

---

### Task 2: deleteOnTermination: true + EBS 조회 경고 (aws-clients.ts)

**Files:**
- Modify: `shared/nextjs-app/src/lib/aws-clients.ts:678-694,728-734,900-916,950-956`

- [ ] **Step 1: Fix startContainer() — EBS lookup with warning flag + deleteOnTermination**

`shared/nextjs-app/src/lib/aws-clients.ts` — lines 678-694, replace the EBS lookup block:

```typescript
  // EBS volume: look up snapshot for data restoration
  let ebsSnapshotId: string | undefined;
  let ebsSizeGiB = 20;
  let userAz: string | undefined;
  let snapshotLookupFailed = false;
  try {
    const { DynamoDBClient, GetItemCommand: DDBGetItem } = await import("@aws-sdk/client-dynamodb");
    const ddb = new DynamoDBClient({ region });
    const volResult = await ddb.send(new DDBGetItem({
      TableName: process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes",
      Key: { user_id: { S: input.subdomain } },
    }));
    ebsSnapshotId = volResult.Item?.snapshot_id?.S;
    const sizeStr = volResult.Item?.size_gb?.N;
    if (sizeStr) ebsSizeGiB = parseInt(sizeStr, 10) || 20;
    userAz = volResult.Item?.az?.S;
    if (ebsSnapshotId) console.log(`[EBS] Restoring from snapshot: ${ebsSnapshotId}, size: ${ebsSizeGiB}GB, az: ${userAz}`);
  } catch (err) {
    snapshotLookupFailed = true;
    console.error(`[EBS] Snapshot lookup failed for ${input.subdomain}:`, err);
  }
```

Then line 734, change `deleteOnTermination`:
```typescript
          terminationPolicy: { deleteOnTermination: true },
```

- [ ] **Step 2: Fix startContainerWithProgress() — same EBS lookup + deleteOnTermination**

`shared/nextjs-app/src/lib/aws-clients.ts` — lines 897-916, replace the EBS lookup block:

```typescript
  // Step 5: Container Start
  onProgress(5, "container_start", "in_progress", "Starting ECS task...");

  // EBS volume: look up snapshot for data restoration
  let ebsSnapshotId: string | undefined;
  let ebsSizeGiB = 20;
  let userAz: string | undefined;
  let snapshotLookupFailed = false;
  try {
    const { DynamoDBClient, GetItemCommand: DDBGetItem } = await import("@aws-sdk/client-dynamodb");
    const ddb = new DynamoDBClient({ region });
    const volResult = await ddb.send(new DDBGetItem({
      TableName: process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes",
      Key: { user_id: { S: input.subdomain } },
    }));
    ebsSnapshotId = volResult.Item?.snapshot_id?.S;
    const sizeStr = volResult.Item?.size_gb?.N;
    if (sizeStr) ebsSizeGiB = parseInt(sizeStr, 10) || 20;
    userAz = volResult.Item?.az?.S;
    if (ebsSnapshotId) console.log(`[EBS] Restoring from snapshot: ${ebsSnapshotId}, size: ${ebsSizeGiB}GB, az: ${userAz}`);
  } catch (err) {
    snapshotLookupFailed = true;
    console.error(`[EBS] Snapshot lookup failed for ${input.subdomain}:`, err);
    onProgress(5, "container_start", "in_progress", "Warning: previous data restoration failed — starting with empty volume");
  }
```

Then line 956, change `deleteOnTermination`:
```typescript
          terminationPolicy: { deleteOnTermination: true },
```

- [ ] **Step 3: Type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors in `aws-clients.ts`

- [ ] **Step 4: Commit**

```bash
git add shared/nextjs-app/src/lib/aws-clients.ts
git commit -m "fix: EBS deleteOnTermination:true + snapshot lookup failure warning"
```

---

### Task 3: Stop API — snapshot Lambda 동기 호출 + warning 응답

**Files:**
- Modify: `shared/nextjs-app/src/app/api/user/container/route.ts:195-217`

- [ ] **Step 1: Change Lambda invocation to sync and add warning response**

`shared/nextjs-app/src/app/api/user/container/route.ts` — replace lines 195-217:

```typescript
      // EBS mode: sync snapshot before ECS deletes volume (deleteOnTermination=true)
      let snapshotWarning: string | undefined;
      if (user.storageType === "ebs") {
        try {
          const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
          const lambda = new LambdaClient({ region });
          const lambdaResult = await lambda.send(new InvokeCommand({
            FunctionName: process.env.EBS_LIFECYCLE_LAMBDA ?? "cc-on-bedrock-ebs-lifecycle",
            InvocationType: "RequestResponse", // sync — must complete before ECS deletes volume
            Payload: Buffer.from(JSON.stringify({
              action: "snapshot_and_detach",
              user_id: user.subdomain,
            })),
          }));
          const payload = JSON.parse(new TextDecoder().decode(lambdaResult.Payload));
          if (payload.statusCode !== 200) {
            snapshotWarning = "Snapshot completed with issues";
            console.warn(`[user/container] EBS snapshot issue for ${user.subdomain}:`, payload.body);
          } else {
            console.log(`[user/container] EBS snapshot completed for ${user.subdomain}`);
          }
        } catch (err) {
          snapshotWarning = "Container stopped but snapshot backup failed — previous snapshot will be used on next start";
          console.warn("[user/container] EBS snapshot trigger failed:", err);
        }
      }

      await stopContainer({ taskArn, reason: "Stopped by user" });

      return NextResponse.json({
        success: true,
        ...(snapshotWarning ? { warning: snapshotWarning } : {}),
      });
    }
```

Key change: snapshot Lambda가 **동기(`RequestResponse`)**로 호출되고, `stopContainer()` **이전에** 실행됨. 이렇게 하면 ECS `deleteOnTermination: true`가 볼륨을 삭제하기 전에 snapshot이 완료됨.

- [ ] **Step 2: Type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shared/nextjs-app/src/app/api/user/container/route.ts
git commit -m "fix: sync EBS snapshot before stop — prevent race with deleteOnTermination"
```

---

### Task 4: SSE stream — snapshot 실패 경고 전달

**Files:**
- Modify: `shared/nextjs-app/src/app/api/user/container/stream/route.ts:136-148`

- [ ] **Step 1: Pass snapshot warning from startContainerWithProgress to SSE**

현재 `stream/route.ts:136-148`에서 `startContainerWithProgress`를 호출하고 `onProgress` 콜백을 받고 있음. `startContainerWithProgress` 내부에서 이미 경고 SSE를 보내므로 (Task 2 Step 2에서 구현), stream route 자체는 변경 불필요.

다만, catch 블록(line 203-208)의 에러 보고를 개선:

`shared/nextjs-app/src/app/api/user/container/stream/route.ts` — lines 203-208:

```typescript
      } catch (err) {
        if (!abortSignal.aborted) {
          const errMsg = err instanceof Error ? err.message : "Provisioning failed";
          send(0, "error", "failed", { error: errMsg });
        }
        console.error("[user/container/stream] SSE error:", err instanceof Error ? err.message : err);
      }
```

변경점: `name: "iam_role"` → `name: "error"` (실제 실패 위치와 무관하게 항상 iam_role로 보고되던 문제 수정)

- [ ] **Step 2: Type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shared/nextjs-app/src/app/api/user/container/stream/route.ts
git commit -m "fix: SSE error event reports actual failure instead of hardcoded iam_role"
```

---

### Task 5: UI — assigned 상태 반영

**Files:**
- Modify: `shared/nextjs-app/src/components/user/environment-tab.tsx:125`

- [ ] **Step 1: Add assigned status mapping**

`shared/nextjs-app/src/components/user/environment-tab.tsx` — line 125, replace:

```typescript
            setRequestStatus(data.data.status === "pending" ? "pending" : data.data.status === "approved" ? "approved" : "none");
```

with:

```typescript
            const s = data.data.status;
            setRequestStatus(
              s === "pending" ? "pending"
              : s === "approved" || s === "assigned" ? "approved"
              : "none"
            );
```

`"assigned"` 상태는 admin이 subdomain을 할당 완료한 상태. 하지만 JWT 갱신 전이라 `user.subdomain`이 아직 없을 수 있음. UI에서는 "승인 완료" 메시지를 보여주고, Cognito verify(`action=verify`)가 새 subdomain을 감지하면 자동으로 컨테이너 시작 가능 상태로 전환됨.

- [ ] **Step 2: Type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shared/nextjs-app/src/components/user/environment-tab.tsx
git commit -m "fix: UI recognizes 'assigned' approval status"
```

---

### Task 6: Stop handler — UI에서 warning 표시

**Files:**
- Modify: `shared/nextjs-app/src/components/user/environment-tab.tsx:195-216`

- [ ] **Step 1: Handle warning in stop response**

`shared/nextjs-app/src/components/user/environment-tab.tsx` — `handleStopContainer` 함수 (lines 195-216), replace:

```typescript
  const handleStopContainer = async () => {
    if (!container) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/user/container", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", taskArn: container.taskArn }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to stop container");
      } else {
        if (data.warning) {
          setError(data.warning); // Show snapshot warning to user
        }
        setContainer(null);
      }
    } catch {
      setError("Failed to stop container");
    } finally {
      setActionLoading(false);
    }
  };
```

변경점: `data.warning`이 있으면 에러 영역에 경고 메시지 표시. 컨테이너는 정상 중지됨.

- [ ] **Step 2: Type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add shared/nextjs-app/src/components/user/environment-tab.tsx
git commit -m "fix: display snapshot warning on container stop"
```

---

### Task 7: Final verification & squash commit

- [ ] **Step 1: Full type check**

Run: `cd /home/ec2-user/cc-on-bedrock/shared/nextjs-app && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 2: Verify Lambda**

Run: `python3 -c "import ast; ast.parse(open('cdk/lib/lambda/ebs-lifecycle.py').read()); print('OK')"`

Expected: `OK`

- [ ] **Step 3: Review all changes**

Run: `git log --oneline -6` to confirm all 6 commits from Tasks 1-6.

Run: `git diff HEAD~6..HEAD --stat` to verify changed files match the plan:
- `cdk/lib/lambda/ebs-lifecycle.py`
- `shared/nextjs-app/src/lib/aws-clients.ts`
- `shared/nextjs-app/src/app/api/user/container/route.ts`
- `shared/nextjs-app/src/app/api/user/container/stream/route.ts`
- `shared/nextjs-app/src/components/user/environment-tab.tsx`

No other files should be modified.
