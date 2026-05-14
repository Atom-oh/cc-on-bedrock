#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { defaultConfig } from '../config/default';
import { NetworkStack } from '../lib/01-network-stack';
import { SecurityStack } from '../lib/02-security-stack';
import { UsageTrackingStack } from '../lib/03-usage-tracking-stack';
import { EcsDevenvStack } from '../lib/04-ecs-devenv-stack';
import { DashboardStack } from '../lib/05-dashboard-stack';
import { WafStack } from '../lib/06-waf-stack';
import { Ec2DevenvStack } from '../lib/07-ec2-devenv-stack';
import { LocalGovernanceStack } from '../lib/08-local-governance-stack';

const app = new cdk.App();

// ADR-014: Local Governance Mode toggle.
//   --context governanceOnly=true   → skip EC2/ECS DevEnv stacks, deploy Local Governance
const governanceOnly = (app.node.tryGetContext('governanceOnly') === true)
  || (String(app.node.tryGetContext('governanceOnly') ?? '').toLowerCase() === 'true');

// ADR-016: separate CloudFront distributions per concern.
//
// Cert context names (kept stable for backward-compat with cdk.context.json):
//   dashboardCertArn   — ALB cert (ap-northeast-2 regional); flips ALB protocol HTTPS/HTTP only
//   cloudfrontCertArn  — Dashboard CloudFront cert (us-east-1)
//   devEnvCertArn      — DevEnv CloudFront cert (us-east-1)  [ADR-016]
//   unifiedCertArn     — DEPRECATED (ADR-013)
const devenvCertArn = (
  app.node.tryGetContext('devEnvCertArn') as string | undefined
) ?? (app.node.tryGetContext('devenvCertArn') as string | undefined);
if (app.node.tryGetContext('unifiedCertArn')) {
  console.warn(
    '[deprecation] unifiedCertArn context is deprecated by ADR-016. ' +
    'Use cloudfrontCertArn (Dashboard CF) and devEnvCertArn (DevEnv CF) instead.',
  );
}

// Read config overrides from CDK context
const config = {
  ...defaultConfig,
  vpcName: app.node.tryGetContext('vpcName') ?? defaultConfig.vpcName,
  vpcCidr: app.node.tryGetContext('vpcCidr') ?? defaultConfig.vpcCidr,
  publicSubnetCidrA: app.node.tryGetContext('publicSubnetCidrA') ?? defaultConfig.publicSubnetCidrA,
  publicSubnetCidrC: app.node.tryGetContext('publicSubnetCidrC') ?? defaultConfig.publicSubnetCidrC,
  privateSubnetCidrA: app.node.tryGetContext('privateSubnetCidrA') ?? defaultConfig.privateSubnetCidrA,
  privateSubnetCidrC: app.node.tryGetContext('privateSubnetCidrC') ?? defaultConfig.privateSubnetCidrC,
  isolatedSubnetCidrA: app.node.tryGetContext('isolatedSubnetCidrA') ?? defaultConfig.isolatedSubnetCidrA,
  isolatedSubnetCidrC: app.node.tryGetContext('isolatedSubnetCidrC') ?? defaultConfig.isolatedSubnetCidrC,
  domainName: app.node.tryGetContext('domainName') ?? defaultConfig.domainName,
  hostedZoneId: app.node.tryGetContext('hostedZoneId') ?? defaultConfig.hostedZoneId,
  devSubdomain: app.node.tryGetContext('devSubdomain') ?? defaultConfig.devSubdomain,
  dashboardSubdomain: app.node.tryGetContext('dashboardSubdomain') ?? defaultConfig.dashboardSubdomain,
  cognitoDomainPrefix: app.node.tryGetContext('cognitoDomainPrefix') ?? defaultConfig.cognitoDomainPrefix,
  opusModelId: app.node.tryGetContext('opusModelId') ?? defaultConfig.opusModelId,
  sonnetModelId: app.node.tryGetContext('sonnetModelId') ?? defaultConfig.sonnetModelId,
  ecsHostInstanceType: app.node.tryGetContext('ecsHostInstanceType') ?? defaultConfig.ecsHostInstanceType,
  ecsClusterName: app.node.tryGetContext('ecsClusterName') ?? defaultConfig.ecsClusterName,
  nodeVersion: app.node.tryGetContext('nodeVersion') ?? defaultConfig.nodeVersion,
  dailyBudgetUsd: Number(app.node.tryGetContext('dailyBudgetUsd')) || defaultConfig.dailyBudgetUsd,
  devenvInstanceType: app.node.tryGetContext('devenvInstanceType') ?? defaultConfig.devenvInstanceType,
  cloudfrontPrefixListId: app.node.tryGetContext('cloudfrontPrefixListId') ?? defaultConfig.cloudfrontPrefixListId,
};


const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
};

// Stack 01: Network
const networkStack = new NetworkStack(app, 'CcOnBedrock-Network', {
  env, config,
  description: 'CC-on-Bedrock: VPC, Subnets, NAT, VPC Endpoints, Route 53',
});

// Stack 02: Security
const securityStack = new SecurityStack(app, 'CcOnBedrock-Security', {
  env, config,
  hostedZone: networkStack.hostedZone,
  description: 'CC-on-Bedrock: Cognito, ACM, KMS, Secrets Manager, IAM',
});
securityStack.addDependency(networkStack);

// Stack 03: Usage Tracking (replaces LiteLLM for spend/token analytics)
const usageTrackingStack = new UsageTrackingStack(app, 'CcOnBedrock-UsageTracking', {
  env, config,
  encryptionKey: securityStack.encryptionKey,
  userPool: securityStack.userPool,
  description: 'CC-on-Bedrock: DynamoDB usage tracking, EventBridge, Lambda',
});
usageTrackingStack.addDependency(securityStack);

// Stack 06: WAF (must be in us-east-1 for CloudFront)
const wafStack = new WafStack(app, 'CcOnBedrock-WAF', {
  config,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  crossRegionReferences: true,
  description: 'CC-on-Bedrock: WAF WebACL for CloudFront distributions',
});

// Stack 04: ECS DevEnv (NLB + Nginx + DevEnv CloudFront, ADR-016)
// Skipped when governanceOnly=true (ADR-014). After ADR-016 split, Stack 05 (Dashboard)
// no longer depends on Stack 04's SGs/NLB DNS, so this gating is now clean.
let ecsDevenvStack: EcsDevenvStack | undefined;
if (!governanceOnly) {
  ecsDevenvStack = new EcsDevenvStack(app, 'CcOnBedrock-EcsDevenv', {
    env, config,
    crossRegionReferences: true,
    vpc: networkStack.vpc,
    encryptionKey: securityStack.encryptionKey,
    taskPermissionBoundary: securityStack.taskPermissionBoundary,
    webAclArn: wafStack.webAclArn,
    devenvCertificateArn: devenvCertArn,
    description: 'CC-on-Bedrock: ECS Cluster, NLB, Nginx Routing, DevEnv CloudFront',
  });
  ecsDevenvStack.addDependency(securityStack);
  ecsDevenvStack.addDependency(wafStack);
}

// Stack 05: Dashboard CloudFront (ADR-016 — dashboard subdomain only)
const dashboardStack = new DashboardStack(app, 'CcOnBedrock-Dashboard', {
  env, config, crossRegionReferences: true,
  vpc: networkStack.vpc,
  encryptionKey: securityStack.encryptionKey,
  dashboardCertificateArn: app.node.tryGetContext('dashboardCertArn'),
  cloudfrontCertificateArn: app.node.tryGetContext('cloudfrontCertArn'),
  // hostedZone imported directly from config to avoid cross-stack export dependency
  userPool: securityStack.userPool,
  // SG props only meaningful in EC2 mode (dashboard container provisions per-user EC2)
  sgOpen: ecsDevenvStack?.sgOpen,
  sgRestricted: ecsDevenvStack?.sgRestricted,
  sgLocked: ecsDevenvStack?.sgLocked,
  ecsInfrastructureRoleArn: securityStack.ecsInfrastructureRole.roleArn,
  webAclArn: wafStack.webAclArn,
  dnsFirewallRuleGroupId: networkStack.dnsFirewallRuleGroupId,
  description: 'CC-on-Bedrock: Dashboard CloudFront (ADR-016 split)',
});
if (ecsDevenvStack) dashboardStack.addDependency(ecsDevenvStack);
dashboardStack.addDependency(wafStack);

// Stack 07: EC2-per-user Dev Environment
// Skipped when governanceOnly=true (ADR-014)
if (!governanceOnly) {
  const ec2DevenvStack = new Ec2DevenvStack(app, 'CcOnBedrock-Ec2Devenv', {
    env, config,
    vpc: networkStack.vpc,
    encryptionKey: securityStack.encryptionKey,
    taskPermissionBoundary: securityStack.taskPermissionBoundary,
    description: 'CC-on-Bedrock: EC2-per-user DevEnv (Launch Template, SG, IAM, DynamoDB)',
  });
  ec2DevenvStack.addDependency(securityStack);
}

// Stack 08: Local Governance Mode (ADR-014)
// Deployed in both modes — Local mode users coexist with EC2 mode users.
// In governanceOnly mode it is the primary user surface.
// ADR-021: allowedModels prop removed — IAM uses wildcard Claude family; runtime token limits gate spend.
const localGovStack = new LocalGovernanceStack(app, 'CcOnBedrock-LocalGovernance', {
  env, config,
  encryptionKey: securityStack.encryptionKey,
  usageTable: usageTrackingStack.usageTable,
  taskPermissionBoundary: securityStack.taskPermissionBoundary,
  description: 'CC-on-Bedrock: Local Governance Mode (STS Issuer, token limits, IAM Deny enforcement)',
});
localGovStack.addDependency(securityStack);
localGovStack.addDependency(usageTrackingStack);

console.log('CC-on-Bedrock CDK App initialized', {
  governanceOnly,
  config: { projectPrefix: config.projectPrefix, domainName: config.domainName },
});
