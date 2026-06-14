import { describe, it, expect } from "vitest";
import { validateIamRequest, DEFAULT_WILDCARD_OK_ACTIONS } from "../iam-request-validation";

// Tiered model (ADR-030): metadata (Describe*/List*) = broad/any-service/Resource:*;
// data reads = any-service but concrete ARN; writes = write-allowlist only;
// secrets = concrete ARN no path-wildcard; dangerous = deny.
const ACCT = "123456789012";
const REGION = "ap-northeast-2";
const WRITE_ALLOWLIST = ["s3", "sqs", "sns", "dynamodb", "lambda", "states", "eks", "ec2", "cloudwatch"];
const opts = { serviceAllowlist: WRITE_ALLOWLIST, wildcardOkActions: DEFAULT_WILDCARD_OK_ACTIONS, accountId: ACCT, region: REGION };

const arn = (svc: string, res: string) => `arn:aws:${svc}:${REGION}:${ACCT}:${res}`;

describe("tiered IAM validation (ADR-030)", () => {
  it("Tier-1 metadata (List*/Describe*) allowed on ANY service with Resource:*", () => {
    expect(validateIamRequest([{ Action: ["athena:ListWorkGroups"], Resource: ["*"] }], opts).ok).toBe(true);
    expect(validateIamRequest([{ Action: ["rds:DescribeDBInstances"], Resource: ["*"] }], opts).ok).toBe(true);
  });

  it("Tier-2 data read allowed on ANY service but ONLY with a concrete ARN", () => {
    // any-service read, concrete ARN → ok
    expect(validateIamRequest([{ Action: ["kinesis:GetRecords"], Resource: [arn("kinesis", "stream/my")] }], opts).ok).toBe(true);
    // same read with Resource:* → rejected (not metadata)
    expect(validateIamRequest([{ Action: ["kinesis:GetRecords"], Resource: ["*"] }], opts).ok).toBe(false);
  });

  it("Tier-4 write REJECTED on a service outside the write-allowlist", () => {
    expect(validateIamRequest([{ Action: ["athena:StartQueryExecution"], Resource: [arn("athena", "workgroup/x")] }], opts).ok).toBe(false);
    // write on an allowlisted service → ok
    expect(validateIamRequest([{ Action: ["dynamodb:PutItem"], Resource: [arn("dynamodb", "table/t")] }], opts).ok).toBe(true);
  });

  it("Tier-3 secret read: concrete secret ok, path wildcard rejected", () => {
    expect(validateIamRequest([{ Action: ["secretsmanager:GetSecretValue"], Resource: [arn("secretsmanager", "secret:foo-AbCdEf")] }], opts).ok).toBe(true);
    expect(validateIamRequest([{ Action: ["secretsmanager:GetSecretValue"], Resource: [arn("secretsmanager", "secret:foo/*")] }], opts).ok).toBe(false);
  });

  it("dangerous actions still rejected regardless of tier", () => {
    expect(validateIamRequest([{ Action: ["iam:PassRole"], Resource: [arn("iam", "role/x")] }], opts).ok).toBe(false);
  });

  // ADR-030 T2 anti-silent-deny: escalation actions on REQUESTABLE (allowlisted) services that
  // boundary X denies at runtime must be rejected at request time too (else "approved but
  // silently dead"). These are write verbs on allowlisted services that would otherwise pass.
  it("boundary-denied escalation on allowlisted services is rejected at request time", () => {
    const denied = [
      ["s3:PutBucketPolicy", arn("s3", "bucket-x")],
      ["s3:DeleteBucketPolicy", arn("s3", "bucket-x")],
      ["s3:PutAccountPublicAccessBlock", "*"],
      ["lambda:AddPermission", arn("lambda", "function:f")],
      ["lambda:AddLayerVersionPermission", arn("lambda", "layer:l")],
      ["sns:AddPermission", arn("sns", "topic-x")],
      ["sqs:AddPermission", arn("sqs", "queue-x")],
      ["ec2:AuthorizeSecurityGroupIngress", arn("ec2", "security-group/sg-1")],
      ["ec2:AuthorizeSecurityGroupEgress", arn("ec2", "security-group/sg-1")],
      ["ec2:ModifySecurityGroupRules", arn("ec2", "security-group/sg-1")],
      // ADR-030 T4 additions on requestable services
      ["ec2:ModifySnapshotAttribute", arn("ec2", "snapshot/snap-1")],
      ["ec2:ModifyImageAttribute", arn("ec2", "image/ami-1")],
      ["eks:CreateAccessEntry", arn("eks", "cluster/c1")],
      ["eks:AssociateAccessPolicy", arn("eks", "cluster/c1")],
      ["dynamodb:PutResourcePolicy", arn("dynamodb", "table/t")],
      ["dynamodb:DeleteResourcePolicy", arn("dynamodb", "table/t")],
    ];
    for (const [action, resource] of denied) {
      expect(
        validateIamRequest([{ Action: [action], Resource: [resource] }], opts).ok,
        `${action} should be rejected (boundary X denies it at runtime)`,
      ).toBe(false);
    }
  });

  // ADR-030 review: the READ tier allows List*/Describe* (any service, Resource:*) and Get* (any
  // service, concrete ARN). Boundary X denies iam/organizations/account/sso/identitystore/ram
  // wholesale + sts:Get*Token — so those reads must be rejected at request time or they'd pass
  // validation then silently runtime-deny. Reads on a non-boundary-denied service stay allowed.
  it("reads on whole-service-denied control planes are rejected (no silent-deny)", () => {
    const rejected: [string, string][] = [
      ["organizations:DescribeOrganization", "*"],
      ["account:GetContactInformation", "*"],
      ["sso:ListInstances", "*"],
      ["identitystore:ListUsers", "*"],
      ["ram:ListResources", "*"],
      ["sts:GetFederationToken", arn("sts", "federated-user/x")],
    ];
    for (const [action, resource] of rejected) {
      expect(
        validateIamRequest([{ Action: [action], Resource: [resource] }], opts).ok,
        `${action} should be rejected (boundary X denies the whole service)`,
      ).toBe(false);
    }
    // sanity: a read on a NON-denied service is still allowed (tier model intact)
    expect(validateIamRequest([{ Action: ["rds:DescribeDBInstances"], Resource: ["*"] }], opts).ok).toBe(true);
  });
});
