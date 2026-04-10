import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import {
  Route53ResolverClient,
  CreateFirewallDomainListCommand,
  DeleteFirewallDomainListCommand,
  UpdateFirewallDomainsCommand,
  ListFirewallDomainsCommand,
  CreateFirewallRuleCommand,
  DeleteFirewallRuleCommand,
  ListFirewallRuleGroupAssociationsCommand,
} from "@aws-sdk/client-route53resolver";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const TABLE = process.env.DLP_DOMAIN_LIST_TABLE ?? "cc-dlp-domain-lists";
const VPC_ID = process.env.VPC_ID ?? "";

const ddb = new DynamoDBClient({ region });
const r53 = new Route53ResolverClient({ region });

// Runtime discovery of DNS Firewall Rule Group ID (cached after first lookup)
let cachedRuleGroupId: string | null = null;
async function getRuleGroupId(): Promise<string> {
  if (cachedRuleGroupId) return cachedRuleGroupId;
  // Try env var first
  const envId = process.env.DNS_FIREWALL_RULE_GROUP_ID;
  if (envId) { cachedRuleGroupId = envId; return envId; }
  // Discover from VPC associations
  const result = await r53.send(new ListFirewallRuleGroupAssociationsCommand({
    VpcId: VPC_ID || undefined,
    Status: "COMPLETE",
  }));
  const assoc = result.FirewallRuleGroupAssociations?.find(
    (a) => a.Name?.includes("cc-on-bedrock")
  ) ?? result.FirewallRuleGroupAssociations?.[0];
  if (!assoc?.FirewallRuleGroupId) throw new Error("No DNS Firewall Rule Group found");
  cachedRuleGroupId = assoc.FirewallRuleGroupId;
  return cachedRuleGroupId;
}

// GET: List domain lists or domains in a specific list
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const action = req.nextUrl.searchParams.get("action") ?? "lists";
  const listId = req.nextUrl.searchParams.get("listId");

  if (action === "lists") {
    const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
    const scanResult = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "SK = :meta",
      ExpressionAttributeValues: { ":meta": { S: "META" } },
    }));
    const lists = (scanResult.Items ?? []).map((item) => unmarshall(item));
    return NextResponse.json({ success: true, data: lists });
  }

  if (action === "domains" && listId) {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": { S: `DOMAINLIST#${listId}` },
        ":prefix": { S: "DOMAIN#" },
      },
    }));
    const domains = (result.Items ?? []).map((item) => unmarshall(item));
    return NextResponse.json({ success: true, data: domains });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// POST: Create a new domain list
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json();
  const { name, listType, tier, domains } = body as {
    name?: string;
    listType?: "ALLOW" | "DENY";
    tier?: "restricted" | "locked";
    domains?: string[];
  };

  if (!name || !listType || !tier || !domains || domains.length === 0) {
    return NextResponse.json({ error: "name, listType (ALLOW/DENY), tier (restricted/locked), and domains[] are required" }, { status: 400 });
  }

  if (!["ALLOW", "DENY"].includes(listType) || !["restricted", "locked"].includes(tier)) {
    return NextResponse.json({ error: "Invalid listType or tier" }, { status: 400 });
  }

  const domainRegex = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
  const invalid = domains.filter((d: string) => !domainRegex.test(d));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Invalid domain format: ${invalid.join(", ")}` }, { status: 400 });
  }

  try {
    const ruleGroupId = await getRuleGroupId();
    // 1. Create FirewallDomainList in Route53 Resolver
    const createResult = await r53.send(new CreateFirewallDomainListCommand({
      Name: `cc-on-bedrock-${tier}-${listType.toLowerCase()}-${Date.now()}`,
      CreatorRequestId: `cc-dlp-${Date.now()}`,
    }));
    const firewallDomainListId = createResult.FirewallDomainList?.Id ?? "";

    // 2. Add domains to the list
    await r53.send(new UpdateFirewallDomainsCommand({
      FirewallDomainListId: firewallDomainListId,
      Operation: "ADD",
      Domains: domains,
    }));

    // 3. Create a firewall rule linking this list to the rule group
    // Query existing rules to find next available priority (avoid collisions)
    const { ListFirewallRulesCommand } = await import("@aws-sdk/client-route53resolver");
    const existingRules = await r53.send(new ListFirewallRulesCommand({
      FirewallRuleGroupId: ruleGroupId,
    }));
    const usedPriorities = new Set((existingRules.FirewallRules ?? []).map((r) => r.Priority));
    const baseRange = listType === "ALLOW" ? 500 : 1000;
    let priority = baseRange;
    while (usedPriorities.has(priority) && priority < baseRange + 400) priority++;
    const action = listType === "ALLOW" ? "ALLOW" : "BLOCK";

    try {
      await r53.send(new CreateFirewallRuleCommand({
        FirewallRuleGroupId: ruleGroupId,
        FirewallDomainListId: firewallDomainListId,
        Priority: priority,
        Action: action,
        ...(action === "BLOCK" ? { BlockResponse: "NXDOMAIN" } : {}),
        Name: `cc-dlp-${tier}-${listType.toLowerCase()}-${firewallDomainListId.slice(-8)}`,
      }));
    } catch (ruleErr) {
      // Cleanup: delete the orphaned domain list if rule creation fails
      await r53.send(new DeleteFirewallDomainListCommand({
        FirewallDomainListId: firewallDomainListId,
      })).catch(() => {});
      throw ruleErr;
    }

    // 4. Save to DynamoDB
    const listId = firewallDomainListId;
    const now = new Date().toISOString();

    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        PK: `DOMAINLIST#${listId}`,
        SK: "META",
        name,
        listType,
        tier,
        firewallDomainListId,
        firewallRuleGroupId: ruleGroupId,
        domainCount: domains.length,
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
        createdBy: session.user.email,
      }),
    }));

    // Save individual domain records
    const batches = [];
    for (let i = 0; i < domains.length; i += 25) {
      const batch = domains.slice(i, i + 25).map((domain: string) => ({
        PutRequest: {
          Item: marshall({
            PK: `DOMAINLIST#${listId}`,
            SK: `DOMAIN#${domain}`,
            domain,
            addedAt: now,
            addedBy: session.user.email,
          }),
        },
      }));
      batches.push(ddb.send(new BatchWriteItemCommand({
        RequestItems: { [TABLE]: batch },
      })));
    }
    await Promise.all(batches);

    return NextResponse.json({
      success: true,
      data: { listId, firewallDomainListId, domainCount: domains.length },
    });
  } catch (err) {
    console.error("[dlp/domains] Create failed:", err);
    return NextResponse.json(
      { error: `Failed to create domain list: ${err instanceof Error ? err.message : "Unknown error"}` },
      { status: 500 }
    );
  }
}

// PUT: Add or remove domains from an existing list
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json();
  const { listId, action, domains } = body as {
    listId?: string;
    action?: "ADD" | "REMOVE";
    domains?: string[];
  };

  if (!listId || !action || !domains || domains.length === 0) {
    return NextResponse.json({ error: "listId, action (ADD/REMOVE), and domains[] required" }, { status: 400 });
  }

  try {
    // Get metadata
    const metaResult = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": { S: `DOMAINLIST#${listId}` }, ":sk": { S: "META" } },
    }));
    const meta = metaResult.Items?.[0] ? unmarshall(metaResult.Items[0]) : null;
    if (!meta) {
      return NextResponse.json({ error: "Domain list not found" }, { status: 404 });
    }

    // Update Route53 Resolver
    await r53.send(new UpdateFirewallDomainsCommand({
      FirewallDomainListId: meta.firewallDomainListId,
      Operation: action,
      Domains: domains,
    }));

    // Update DynamoDB
    const now = new Date().toISOString();
    if (action === "ADD") {
      const batches = [];
      for (let i = 0; i < domains.length; i += 25) {
        const batch = domains.slice(i, i + 25).map((domain: string) => ({
          PutRequest: {
            Item: marshall({
              PK: `DOMAINLIST#${listId}`,
              SK: `DOMAIN#${domain}`,
              domain,
              addedAt: now,
              addedBy: session.user.email,
            }),
          },
        }));
        batches.push(ddb.send(new BatchWriteItemCommand({ RequestItems: { [TABLE]: batch } })));
      }
      await Promise.all(batches);
    } else {
      const batches = [];
      for (let i = 0; i < domains.length; i += 25) {
        const batch = domains.slice(i, i + 25).map((domain: string) => ({
          DeleteRequest: { Key: marshall({ PK: `DOMAINLIST#${listId}`, SK: `DOMAIN#${domain}` }) },
        }));
        batches.push(ddb.send(new BatchWriteItemCommand({ RequestItems: { [TABLE]: batch } })));
      }
      await Promise.all(batches);
    }

    // Update domain count
    const countResult = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: `DOMAINLIST#${listId}` }, ":prefix": { S: "DOMAIN#" } },
      Select: "COUNT",
    }));

    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `DOMAINLIST#${listId}`, SK: "META" }),
      UpdateExpression: "SET domainCount = :count, updatedAt = :now",
      ExpressionAttributeValues: { ":count": { N: String(countResult.Count ?? 0) }, ":now": { S: now } },
    }));

    return NextResponse.json({ success: true, domainCount: countResult.Count });
  } catch (err) {
    console.error("[dlp/domains] Update failed:", err);
    return NextResponse.json(
      { error: `Failed to update domains: ${err instanceof Error ? err.message : "Unknown error"}` },
      { status: 500 }
    );
  }
}

// DELETE: Delete an entire domain list
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json();
  const { listId } = body as { listId?: string };

  if (!listId) {
    return NextResponse.json({ error: "listId is required" }, { status: 400 });
  }

  try {
    // Get metadata
    const metaResult = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": { S: `DOMAINLIST#${listId}` }, ":sk": { S: "META" } },
    }));
    const meta = metaResult.Items?.[0] ? unmarshall(metaResult.Items[0]) : null;
    if (!meta) {
      return NextResponse.json({ error: "Domain list not found" }, { status: 404 });
    }

    // 1. Delete firewall rule from rule group
    await r53.send(new DeleteFirewallRuleCommand({
      FirewallRuleGroupId: meta.firewallRuleGroupId,
      FirewallDomainListId: meta.firewallDomainListId,
    })).catch((err) => console.warn("[dlp/domains] DeleteFirewallRule:", err.message));

    // 2. Delete the domain list
    await r53.send(new DeleteFirewallDomainListCommand({
      FirewallDomainListId: meta.firewallDomainListId,
    })).catch((err) => console.warn("[dlp/domains] DeleteFirewallDomainList:", err.message));

    // 3. Delete all DynamoDB records for this list
    const allItems = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": { S: `DOMAINLIST#${listId}` } },
      ProjectionExpression: "PK, SK",
    }));

    const batches = [];
    const items = allItems.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((item) => ({
        DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
      }));
      batches.push(ddb.send(new BatchWriteItemCommand({ RequestItems: { [TABLE]: batch } })));
    }
    await Promise.all(batches);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[dlp/domains] Delete failed:", err);
    return NextResponse.json(
      { error: `Failed to delete domain list: ${err instanceof Error ? err.message : "Unknown error"}` },
      { status: 500 }
    );
  }
}
