import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  Route53ResolverClient,
  ListFirewallRuleGroupAssociationsCommand,
  ListFirewallRulesCommand,
  ListFirewallDomainListsCommand,
  GetFirewallDomainListCommand,
} from "@aws-sdk/client-route53resolver";
import {
  EC2Client,
  DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";
import {
  CloudTrailClient,
  LookupEventsCommand,
} from "@aws-sdk/client-cloudtrail";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const vpcId = process.env.VPC_ID ?? "";
const r53Client = new Route53ResolverClient({ region });
const ec2Client = new EC2Client({ region });
const ctClient = new CloudTrailClient({ region });
const cognitoClient = new CognitoIdentityProviderClient({ region });
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";

// Known SG IDs
const DLP_SGS: Record<string, string> = {
  open: process.env.SG_DEVENV_OPEN ?? "",
  restricted: process.env.SG_DEVENV_RESTRICTED ?? "",
  locked: process.env.SG_DEVENV_LOCKED ?? "",
};

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") ?? "overview";

  try {
    switch (action) {
      case "overview": {
        // Get DNS Firewall associations
        const assocResult = await r53Client.send(
          new ListFirewallRuleGroupAssociationsCommand({ VpcId: vpcId })
        );
        const associations = (assocResult.FirewallRuleGroupAssociations ?? []).map((a) => ({
          name: a.Name,
          status: a.Status,
          priority: a.Priority,
          ruleGroupId: a.FirewallRuleGroupId,
        }));

        // Get DNS Firewall rules for each associated group
        const ruleGroups = [];
        for (const assoc of associations) {
          if (!assoc.ruleGroupId) continue;
          const rulesResult = await r53Client.send(
            new ListFirewallRulesCommand({ FirewallRuleGroupId: assoc.ruleGroupId })
          );
          const rules = (rulesResult.FirewallRules ?? []).map((r) => ({
            name: r.Name,
            priority: r.Priority,
            action: r.Action,
            blockResponse: r.BlockResponse,
            domainListId: r.FirewallDomainListId,
          }));
          ruleGroups.push({ ...assoc, rules });
        }

        // Get Security Groups
        const sgIds = Object.values(DLP_SGS);
        const sgResult = await ec2Client.send(
          new DescribeSecurityGroupsCommand({ GroupIds: sgIds })
        );
        const securityGroups = (sgResult.SecurityGroups ?? []).map((sg) => {
          const policy = Object.entries(DLP_SGS).find(([, id]) => id === sg.GroupId)?.[0] ?? "unknown";
          return {
            id: sg.GroupId,
            name: sg.GroupName,
            description: sg.Description,
            policy,
            ingressRules: (sg.IpPermissions ?? []).map((r) => ({
              protocol: r.IpProtocol,
              fromPort: r.FromPort,
              toPort: r.ToPort,
              sources: [
                ...(r.IpRanges ?? []).map((ip) => ip.CidrIp),
                ...(r.UserIdGroupPairs ?? []).map((g) => `sg:${g.GroupId}`),
                ...(r.PrefixListIds ?? []).map((p) => `pl:${p.PrefixListId}`),
              ],
              description: r.IpRanges?.[0]?.Description ?? r.UserIdGroupPairs?.[0]?.Description ?? "",
            })),
            egressRules: (sg.IpPermissionsEgress ?? []).map((r) => ({
              protocol: r.IpProtocol,
              fromPort: r.FromPort,
              toPort: r.ToPort,
              destinations: [
                ...(r.IpRanges ?? []).map((ip) => ip.CidrIp),
                ...(r.UserIdGroupPairs ?? []).map((g) => `sg:${g.GroupId}`),
                ...(r.PrefixListIds ?? []).map((p) => `pl:${p.PrefixListId}`),
              ],
            })),
          };
        });

        return NextResponse.json({
          success: true,
          data: { dnsFirewall: { associations, ruleGroups }, securityGroups },
        });
      }

      case "domain_list": {
        const domainListId = searchParams.get("id");
        if (!domainListId) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        const result = await r53Client.send(
          new GetFirewallDomainListCommand({ FirewallDomainListId: domainListId })
        );
        return NextResponse.json({
          success: true,
          data: {
            name: result.FirewallDomainList?.Name,
            count: result.FirewallDomainList?.DomainCount,
          },
        });
      }

      case "user_security": {
        // Get all users with their security policies
        const usersResult = await cognitoClient.send(
          new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60 })
        );
        const getAttr = (attrs: AttributeType[] | undefined, name: string) =>
          attrs?.find((a) => a.Name === name)?.Value;

        const users = (usersResult.Users ?? []).map((u) => ({
          username: u.Username,
          email: getAttr(u.Attributes, "email") ?? "",
          enabled: u.Enabled ?? false,
          status: u.UserStatus ?? "",
          subdomain: getAttr(u.Attributes, "custom:subdomain") ?? "",
          securityPolicy: getAttr(u.Attributes, "custom:security_policy") ?? "open",
          containerOs: getAttr(u.Attributes, "custom:container_os") ?? "ubuntu",
          resourceTier: getAttr(u.Attributes, "custom:resource_tier") ?? "standard",
          hasEnvironment: !!getAttr(u.Attributes, "custom:subdomain"),
          createdAt: u.UserCreateDate?.toISOString() ?? "",
        }));
        return NextResponse.json({ success: true, data: users });
      }

      case "audit_logs": {
        const hours = parseInt(searchParams.get("hours") ?? "24", 10);
        const startTime = new Date(Date.now() - hours * 3600000);

        // Fetch CloudTrail events for key services
        const [bedrockEvents, cognitoEvents, ec2Events] = await Promise.all([
          ctClient.send(new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "EventSource", AttributeValue: "bedrock.amazonaws.com" }],
            StartTime: startTime, MaxResults: 20,
          })).catch(() => ({ Events: [] })),
          ctClient.send(new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "EventSource", AttributeValue: "cognito-idp.amazonaws.com" }],
            StartTime: startTime, MaxResults: 20,
          })).catch(() => ({ Events: [] })),
          ctClient.send(new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "EventSource", AttributeValue: "ec2.amazonaws.com" }],
            StartTime: startTime, MaxResults: 20,
          })).catch(() => ({ Events: [] })),
        ]);

        const formatEvents = (events: typeof bedrockEvents.Events, source: string) =>
          (events ?? []).map((e) => ({
            time: e.EventTime?.toISOString() ?? "",
            source,
            event: e.EventName ?? "",
            user: e.Username ?? "",
            sourceIp: (() => {
              try { return e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent).sourceIPAddress : ""; } catch { return ""; }
            })(),
            errorCode: (() => {
              try { return e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent).errorCode : ""; } catch { return ""; }
            })(),
          }));

        const allEvents = [
          ...formatEvents(bedrockEvents.Events, "Bedrock"),
          ...formatEvents(cognitoEvents.Events, "Cognito"),
          ...formatEvents(ec2Events.Events, "EC2"),
        ].sort((a, b) => b.time.localeCompare(a.time));

        return NextResponse.json({ success: true, data: allEvents });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[security]", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
