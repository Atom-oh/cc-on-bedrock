/**
 * ADR-026 — IAM permission request validation.
 *
 * Developers request specific (action, resource) pairs; an admin approves. The
 * security model is NOT a narrow boundary but "no wildcards + admin review", so
 * this validator is the first gate: it REJECTS wildcard actions/resources and
 * dangerous resource-policy/delegation actions, and confines requests to an
 * admin-controlled service allowlist within the platform account/region.
 *
 * Resolution rules (see ADR-026 Decision / plan T1):
 *   - reject `*`, `*:*`, service-wildcard actions (`s3:*`)
 *   - reject `NotAction`/`NotResource`
 *   - reject `Resource:"*"` EXCEPT when every action in the statement is a
 *     resource-level-unsupported action (e.g. `ec2:Describe*`)
 *   - reject namespace-wide ARN wildcards (`arn:...:*`, `table/*`) but allow
 *     legit object-path wildcards (`arn:aws:s3:::bucket/prefix/*`)
 *   - reject dangerous actions (resource-policy / public-making / delegation)
 *   - reject services outside the allowlist and cross-account ARNs
 */

export interface IamStatement {
  Action: string[];
  Resource: string[];
}

export interface ValidateOpts {
  /** lowercased service names devs may request, e.g. ["s3","sqs",...] */
  serviceAllowlist: string[];
  /** actions that don't support resource-level perms → Resource:"*" allowed.
   *  lowercased; a trailing `*` is a prefix glob (e.g. "ec2:describe*"). */
  wildcardOkActions: string[];
  /** dangerous actions to deny outright; defaults applied when omitted */
  dangerousActionDenylist?: RegExp[];
  /** platform account id; cross-account ARNs are rejected when set */
  accountId?: string;
  /** platform region; cross-region ARNs are rejected when set (empty = global) */
  region?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// Resource-policy mutation, public-making, and privilege-delegation actions.
// These can escalate beyond the granted resource even when scoped to "own" ARNs.
const DEFAULT_DANGEROUS: RegExp[] = [
  /:(put|delete)[a-z]*policy$/i, // s3:PutBucketPolicy/DeleteBucketPolicy, *Put/DeleteResourcePolicy, ...
  /:set[a-z]*attributes$/i, // sns:SetTopicAttributes, sqs:SetQueueAttributes
  /:(add|remove|put)[a-z]*permission$/i, // *AddPermission/RemovePermission/PutPermission, lambda:AddLayerVersionPermission — opens resource policy cross-account/public
  /:put[a-z]*publicaccessblock$/i, // s3:PutAccountPublicAccessBlock / PutPublicAccessBlock — disables public-access protection
  /^ec2:(authorize|revoke|modify)securitygroup/i, // SG ingress/egress mutation — network exposure / lateral movement
  /^iam:/i, // any iam:* (PassRole, CreateRole, ...)
  /^sts:assumerole/i,
  /:[a-z]*resourcepolicy$/i, // *PutResourcePolicy / *DeleteResourcePolicy
];
// ADR-030 T2 coherence: every boundary-X DenyEscalation action on a *requestable*
// (write-allowlisted) service MUST also match a pattern above — otherwise an admin could
// approve a request that the runtime boundary then silently denies. Enforced by
// scripts/check-policyset-boundary.py invariant (b). Adding to the boundary Deny floor on a
// requestable service therefore requires adding the matching dangerous pattern here.

function actionMatchesAny(action: string, patterns: string[]): boolean {
  const a = action.toLowerCase();
  return patterns.some((p) => {
    const pl = p.toLowerCase();
    return pl.endsWith("*") ? a.startsWith(pl.slice(0, -1)) : a === pl;
  });
}

// ADR-026 T8: read-only action prefixes that may use a single trailing '*' wildcard.
// Low blast radius (List/Get/Describe = non-mutating); still subject to the service
// allowlist + dangerous-action denylist.
const READ_WILDCARD_PREFIXES = ["get", "list", "describe", "batchget", "query", "scan"];

/** True ONLY for a bare read-verb wildcard: a read prefix followed by a single trailing '*'.
 *  Allowed: "Get*", "List*", "Describe*", "BatchGet*", "Query*", "Scan*".
 *  Rejected: "*", "Put*", "GetObject*" / "GetBucketPolicy*" (verb+suffix → info-disclosure/escalation
 *  bypass — gate consensus), "Get*Policy*" (embedded '*'), "Get?" (glob). `op` is the part after ':'.
 *  Exact-match (===) not startsWith: a user wanting a specific read names it without a wildcard. */
function isReadWildcardOp(op: string): boolean {
  if (!op || op.includes("?")) return false;
  if (!op.endsWith("*")) return false;
  const stem = op.slice(0, -1);
  if (stem.includes("*")) return false;
  const s = stem.toLowerCase();
  return READ_WILDCARD_PREFIXES.some((p) => s === p);
}

// ADR-030 Tier-1: List*/Describe* are pure metadata (no bulk data/secrets) — `Resource:*`
// is acceptable on ANY service. NOTE: Get* is deliberately NOT here (kinesis:GetRecords,
// dynamodb:GetItem, s3:GetObject, secretsmanager:GetSecretValue, … read data/secrets).
function isMetadataAction(action: string): boolean {
  const op = (action.split(":")[1] ?? "").toLowerCase();
  const verb = op.endsWith("*") ? op.slice(0, -1) : op;
  return verb.startsWith("list") || verb.startsWith("describe");
}

// ADR-030: read-tier actions bypass the WRITE service allowlist (reads are allowed on any
// service — still concrete-ARN-scoped by the resource rules below, except metadata). Write
// actions (Put/Update/Delete/Create/…) stay confined to the allowlist. Unknown verbs default
// to write-tier (allowlist-gated) — the safe direction.
function isReadTierAction(action: string, wildcardOk: string[]): boolean {
  if (actionMatchesAny(action, wildcardOk)) return true;
  const op = (action.split(":")[1] ?? "").toLowerCase();
  return READ_WILDCARD_PREFIXES.some((p) => op.startsWith(p));
}

export function validateIamRequest(statements: IamStatement[], opts: ValidateOpts): ValidationResult {
  const errors: string[] = [];
  const dangerous = opts.dangerousActionDenylist ?? DEFAULT_DANGEROUS;
  const allowlist = opts.serviceAllowlist.map((s) => s.toLowerCase());

  for (const raw of statements) {
    const obj = raw as unknown as Record<string, unknown>;
    if (obj.NotAction || obj.NotResource) {
      errors.push("NotAction/NotResource is not allowed");
      continue;
    }
    const actions = Array.isArray(raw.Action) ? raw.Action : [];
    const resources = Array.isArray(raw.Resource) ? raw.Resource : [];
    if (actions.length === 0) errors.push("Action[] is required");
    if (resources.length === 0) errors.push("Resource[] is required");

    const actionServices = new Set<string>();
    for (const action of actions) {
      if (action === "*" || action === "*:*") {
        errors.push(`wildcard action not allowed: ${action}`);
        continue;
      }
      const [svc, op] = action.split(":");
      if (!svc || !op) {
        errors.push(`invalid action format: ${action}`);
        continue;
      }
      // Wildcards in the action op are rejected EXCEPT read-only patterns
      // (Get*/List*/Describe*/BatchGet*/Query*/Scan* — single trailing '*').
      // Read wildcards still fall through to the allowlist + dangerous-action
      // checks below; write/partial wildcards (s3:Put*Policy, lambda:*Permission,
      // s3:*) stay rejected so they can't evade the dangerous-action denylist.
      if (op.includes("*") || op.includes("?")) {
        if (!isReadWildcardOp(op)) {
          errors.push(`wildcard not allowed in action (read-only Get*/List*/Describe*/BatchGet*/Query*/Scan* only): ${action}`);
          continue;
        }
      }
      actionServices.add(svc.toLowerCase());
      // ADR-030 tiered: the service allowlist gates WRITE/mutate actions only. Reads
      // (Get*/List*/Describe*/Query/Scan/BatchGet* + wildcard-ok set) are allowed on ANY
      // service — they stay concrete-ARN-scoped below (except List*/Describe* metadata).
      if (!isReadTierAction(action, opts.wildcardOkActions) && !allowlist.includes(svc.toLowerCase())) {
        errors.push(`service not in write-allowlist: ${svc}`);
      }
      if (dangerous.some((re) => re.test(action))) {
        errors.push(`dangerous action not allowed: ${action}`);
      }
    }

    // Resource:'*' is allowed ONLY for the configured wildcard-ok actions (e.g. ec2:describe*,
    // s3:listallmybuckets) — actions that genuinely lack resource-level scoping. Read-only wildcard
    // ops (s3:Get*/List*) are NOT auto-granted Resource:* — they must be scoped to a concrete ARN,
    // else `s3:Get*`+Resource:* = account-wide reads (gate consensus: codex/kiro HIGH).
    // ADR-030 Tier-1: Resource:'*' allowed for the resource-level-unsupported wildcard-ok set
    // OR for pure metadata (List*/Describe*) on any service. Data reads (Get*/Query/Scan) are
    // NOT eligible — they must be scoped to a concrete ARN.
    const allActionsWildcardOk = actions.length > 0 && actions.every((a) => actionMatchesAny(a, opts.wildcardOkActions) || isMetadataAction(a));
    for (const res of resources) {
      if (res === "*") {
        if (!allActionsWildcardOk) {
          errors.push("Resource:'*' only allowed for resource-level-unsupported actions");
        }
        continue;
      }
      if (!res.toLowerCase().startsWith("arn:")) {
        errors.push(`resource must be an ARN or '*': ${res}`);
        continue;
      }
      const parts = res.split(":"); // arn:partition:service:region:account:resource...
      const arnService = (parts[2] ?? "").toLowerCase();
      const region = parts[3] ?? "";
      const account = parts[4] ?? "";
      const resourcePart = parts.slice(5).join(":");
      if (resourcePart === "" || resourcePart === "*") {
        errors.push(`resource too broad: ${res}`);
        continue;
      }
      // Wildcards: only S3 object keys may use them, and only AFTER a concrete
      // bucket + "/" (e.g. bucket/prefix/*). Reject bucket-name wildcards (my*)
      // and any wildcard in non-S3 resource ids (table/*, my-queue*).
      if (/[*?]/.test(resourcePart)) {
        const slash = resourcePart.indexOf("/");
        const bucket = slash >= 0 ? resourcePart.slice(0, slash) : resourcePart;
        if (arnService !== "s3" || slash < 0 || bucket.length === 0 || /[*?]/.test(bucket)) {
          errors.push(`wildcard not allowed in resource id (use s3 bucket/prefix/*): ${res}`);
          continue;
        }
      }
      // resource ARN service must match one of the statement's action services
      if (actionServices.size > 0 && !actionServices.has(arnService)) {
        errors.push(`resource service '${arnService}' does not match action service(s): ${res}`);
      }
      if (account && opts.accountId && account !== opts.accountId) {
        errors.push(`cross-account ARN not allowed: ${res}`);
      }
      if (region && opts.region && region !== opts.region) {
        errors.push(`cross-region ARN not allowed: ${res}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ADR-026 T2 — defaults for the self-service request path. The service allowlist
// is the set of services a developer may request at all (admin-controlled ceiling);
// it MUST stay ⊆ the boundary (enforced by the T6 CI check).
export const DEFAULT_SERVICE_ALLOWLIST = ["s3", "sqs", "sns", "dynamodb", "lambda", "states", "eks", "ec2", "cloudwatch"];

// Actions that don't support resource-level permissions → Resource:"*" is allowed.
export const DEFAULT_WILDCARD_OK_ACTIONS = [
  "ec2:describe*",
  "s3:listallmybuckets",
  "cloudwatch:getmetricdata",
  "cloudwatch:listmetrics",
  "states:liststatemachines",
];

export interface IamExtensionInput {
  statements: IamStatement[];
  reason?: string;
}

export interface BuiltIamExtension {
  ok: boolean;
  errors: string[];
  /** validated statements serialized for DynamoDB storage (set only when ok) */
  statementsJson?: string;
}

/**
 * ADR-026 T2 — validate a free-form iam_extension request and produce the
 * DynamoDB-ready payload. The route persists `statementsJson` + sub + department
 * on the approval row; an admin later approves and the statements are attached
 * (after server-side re-validation in T5).
 */
export function buildIamExtensionRequest(input: IamExtensionInput, opts: ValidateOpts): BuiltIamExtension {
  if (!input || !Array.isArray(input.statements) || input.statements.length === 0) {
    return { ok: false, errors: ["statements[] is required"] };
  }
  const v = validateIamRequest(input.statements, opts);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, errors: [], statementsJson: JSON.stringify(input.statements) };
}
