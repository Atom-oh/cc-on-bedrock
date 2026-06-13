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
});
