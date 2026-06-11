import { describe, it, expect } from "vitest";
import {
  validateIamRequest,
  buildIamExtensionRequest,
  DEFAULT_SERVICE_ALLOWLIST,
  DEFAULT_WILDCARD_OK_ACTIONS,
  type IamStatement,
} from "../iam-request-validation";

const OPTS = {
  serviceAllowlist: ["s3", "sqs", "sns", "dynamodb", "lambda", "states", "eks", "ec2", "cloudwatch"],
  // actions that don't support resource-level perms → Resource:* allowed
  wildcardOkActions: ["ec2:describe*", "s3:listallmybuckets", "cloudwatch:getmetricdata", "states:liststatemachines"],
  accountId: "180294183052",
  region: "ap-northeast-2",
};

function st(Action: string[], Resource: string[]): IamStatement {
  return { Action, Resource };
}

describe("validateIamRequest — rejects unsafe", () => {
  it("rejects Resource:* for a resource-level-capable action", () => {
    const r = validateIamRequest([st(["sqs:SendMessage"], ["*"])], OPTS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Resource/i);
  });

  it("rejects service-wildcard action (s3:*)", () => {
    const r = validateIamRequest([st(["s3:*"], ["arn:aws:s3:::my-bucket/data/*"])], OPTS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/wildcard/i);
  });

  it("rejects Action:* and *:*", () => {
    expect(validateIamRequest([st(["*"], ["arn:aws:s3:::b/x"])], OPTS).ok).toBe(false);
    expect(validateIamRequest([st(["*:*"], ["arn:aws:s3:::b/x"])], OPTS).ok).toBe(false);
  });

  it("rejects NotResource / NotAction statements", () => {
    const bad = { NotAction: ["s3:GetObject"], Resource: ["arn:aws:s3:::b/x"] } as unknown as IamStatement;
    expect(validateIamRequest([bad], OPTS).ok).toBe(false);
  });

  it("rejects whole-ARN and namespace wildcards (arn:*:*, :*, table/*)", () => {
    expect(validateIamRequest([st(["dynamodb:GetItem"], ["arn:aws:dynamodb:ap-northeast-2:180294183052:table/*"])], OPTS).ok).toBe(false);
    expect(validateIamRequest([st(["sqs:SendMessage"], ["arn:aws:sqs:ap-northeast-2:180294183052:*"])], OPTS).ok).toBe(false);
  });

  it("rejects dangerous resource-policy / delegation actions", () => {
    for (const a of ["s3:PutBucketPolicy", "sns:SetTopicAttributes", "sqs:SetQueueAttributes", "lambda:AddPermission", "iam:PassRole"]) {
      expect(validateIamRequest([st([a], ["arn:aws:s3:::b/x"])], OPTS).ok).toBe(false);
    }
  });

  // ADR-026 T8: read-only wildcards (s3:Get*) are now ALLOWED; write/embedded/glob stay rejected.
  it("rejects write/embedded/glob wildcard actions (Put*Policy, *Permission, PassRole*, Send?essage)", () => {
    for (const a of ["s3:Put*Policy", "lambda:*Permission", "iam:PassRole*", "sqs:Send?essage"]) {
      const r = validateIamRequest([st([a], ["arn:aws:s3:::b/x"])], OPTS);
      expect(r.ok, a).toBe(false);
    }
  });

  it("rejects bare prefix-wildcard resources (my*, *) not after a path segment", () => {
    expect(validateIamRequest([st(["s3:GetObject"], ["arn:aws:s3:::my*"])], OPTS).ok).toBe(false);
    expect(validateIamRequest([st(["s3:GetObject"], ["arn:aws:s3:::*"])], OPTS).ok).toBe(false);
    expect(validateIamRequest([st(["sqs:SendMessage"], ["arn:aws:sqs:ap-northeast-2:180294183052:my-queue*"])], OPTS).ok).toBe(false);
  });

  it("rejects action/resource service mismatch", () => {
    const r = validateIamRequest([st(["sqs:SendMessage"], ["arn:aws:s3:::bucket/x"])], OPTS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/service/i);
  });

  it("rejects actions for services outside the allowlist", () => {
    expect(validateIamRequest([st(["kms:Decrypt"], ["arn:aws:kms:ap-northeast-2:180294183052:key/abc"])], OPTS).ok).toBe(false);
  });

  it("rejects cross-account ARNs", () => {
    const r = validateIamRequest([st(["sqs:SendMessage"], ["arn:aws:sqs:ap-northeast-2:999999999999:q"])], OPTS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/account/i);
  });
});

describe("validateIamRequest — allows safe", () => {
  it("allows concrete resource ARN with specific action", () => {
    expect(validateIamRequest([st(["sqs:SendMessage", "sqs:ReceiveMessage"], ["arn:aws:sqs:ap-northeast-2:180294183052:my-queue"])], OPTS).ok).toBe(true);
  });

  it("allows legit object-path wildcard (bucket/prefix/*)", () => {
    expect(validateIamRequest([st(["s3:GetObject", "s3:PutObject"], ["arn:aws:s3:::my-bucket/data/*"])], OPTS).ok).toBe(true);
  });

  it("allows Resource:* ONLY for resource-level-unsupported actions", () => {
    expect(validateIamRequest([st(["ec2:DescribeInstances"], ["*"])], OPTS).ok).toBe(true);
    expect(validateIamRequest([st(["s3:ListAllMyBuckets"], ["*"])], OPTS).ok).toBe(true);
  });

  it("rejects mixing a wildcard-ok action with a resource-level action under Resource:*", () => {
    // ec2:DescribeInstances is wildcard-ok but sqs:SendMessage is not → Resource:* must be rejected
    const r = validateIamRequest([st(["ec2:DescribeInstances", "sqs:SendMessage"], ["*"])], OPTS);
    expect(r.ok).toBe(false);
  });
});

describe("buildIamExtensionRequest", () => {
  const OPTS2 = {
    serviceAllowlist: DEFAULT_SERVICE_ALLOWLIST,
    wildcardOkActions: DEFAULT_WILDCARD_OK_ACTIONS,
    accountId: "180294183052",
    region: "ap-northeast-2",
  };

  it("returns error when statements missing/empty", () => {
    expect(buildIamExtensionRequest({ statements: [] }, OPTS2).ok).toBe(false);
    // @ts-expect-error invalid shape
    expect(buildIamExtensionRequest({}, OPTS2).ok).toBe(false);
  });

  it("rejects when validation fails (Resource:*)", () => {
    const r = buildIamExtensionRequest({ statements: [{ Action: ["sqs:SendMessage"], Resource: ["*"] }] }, OPTS2);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("returns ok + JSON for a valid request", () => {
    const stmts: IamStatement[] = [{ Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:ap-northeast-2:180294183052:my-queue"] }];
    const r = buildIamExtensionRequest({ statements: stmts, reason: "need queue" }, OPTS2);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.statementsJson!)).toEqual(stmts);
  });

  it("default allowlist includes core dev services", () => {
    for (const s of ["s3", "sqs", "sns", "dynamodb", "lambda"]) {
      expect(DEFAULT_SERVICE_ALLOWLIST).toContain(s);
    }
  });
});

describe("validateIamRequest — read-only wildcard actions (ADR-026 T8)", () => {
  it("allows s3:Get* with a scoped object ARN", () => {
    const r = validateIamRequest([st(["s3:Get*"], ["arn:aws:s3:::my-bucket/data/*"])], OPTS);
    expect(r.ok).toBe(true);
  });
  it("allows s3:List* with Resource:* (read-only)", () => {
    const r = validateIamRequest([st(["s3:List*"], ["*"])], OPTS);
    expect(r.ok).toBe(true);
  });
  it("allows dynamodb:Query* / Scan* / BatchGet* with a concrete table ARN", () => {
    const arn = "arn:aws:dynamodb:ap-northeast-2:180294183052:table/cc-on-bedrock-usage";
    for (const a of ["dynamodb:Query*", "dynamodb:Scan*", "dynamodb:BatchGet*"]) {
      const r = validateIamRequest([st([a], [arn])], OPTS);
      expect(r.ok, `${a} should pass`).toBe(true);
    }
  });
  it("allows ec2:Describe* with Resource:*", () => {
    expect(validateIamRequest([st(["ec2:Describe*"], ["*"])], OPTS).ok).toBe(true);
  });

  it("still rejects full service wildcard s3:*", () => {
    expect(validateIamRequest([st(["s3:*"], ["*"])], OPTS).ok).toBe(false);
  });
  it("rejects write wildcards (Put*/Delete*/Create*)", () => {
    for (const a of ["s3:Put*", "s3:Delete*", "dynamodb:Create*"]) {
      expect(validateIamRequest([st([a], ["arn:aws:s3:::b/x/*"])], OPTS).ok, `${a} should fail`).toBe(false);
    }
  });
  it("rejects embedded wildcard (Get*Policy*) and glob (?)", () => {
    expect(validateIamRequest([st(["s3:Get*Policy*"], ["*"])], OPTS).ok).toBe(false);
    expect(validateIamRequest([st(["s3:Get?"], ["*"])], OPTS).ok).toBe(false);
  });
  it("rejects read wildcard for a non-allowlist service (iam:Get*)", () => {
    expect(validateIamRequest([st(["iam:Get*"], ["*"])], OPTS).ok).toBe(false);
  });
  it("rejects Resource:* when a write action is mixed with read wildcards", () => {
    const r = validateIamRequest([st(["s3:List*", "s3:PutObject"], ["*"])], OPTS);
    expect(r.ok).toBe(false);
  });
});
