#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { defaultConfig } from '../config/default';
import { NetworkStack } from '../lib/01-network-stack';
import { SecurityStack } from '../lib/02-security-stack';
import { UsageTrackingStack } from '../lib/03-usage-tracking-stack';
import { EcsDevenvStack } from '../lib/04-ecs-devenv-stack';
import { DashboardStack } from '../lib/05-dashboard-stack';

const app = new cdk.App();

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
  devSubdomain: app.node.tryGetContext('devSubdomain') ?? defaultConfig.devSubdomain,
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

// Stack 04: ECS Dev Environment
const ecsDevenvStack = new EcsDevenvStack(app, 'CcOnBedrock-EcsDevenv', {
  env, config,
  vpc: networkStack.vpc,
  encryptionKey: securityStack.encryptionKey,
  devEnvCertificateArn: app.node.tryGetContext('devEnvCertArn'),
  hostedZone: networkStack.hostedZone,
  cloudfrontSecret: securityStack.cloudfrontSecret,
  description: 'CC-on-Bedrock: ECS Cluster, Task Definitions, EFS, CloudFront',
});
ecsDevenvStack.addDependency(securityStack);

// Stack 05: Dashboard
const dashboardStack = new DashboardStack(app, 'CcOnBedrock-Dashboard', {
  env, config,
  vpc: networkStack.vpc,
  encryptionKey: securityStack.encryptionKey,
  dashboardEc2Role: securityStack.dashboardEc2Role,
  dashboardCertificateArn: app.node.tryGetContext('dashboardCertArn'),
  hostedZone: networkStack.hostedZone,
  cloudfrontSecret: securityStack.cloudfrontSecret,
  userPool: securityStack.userPool,
  userPoolClient: securityStack.userPoolClient,
  description: 'CC-on-Bedrock: Next.js Dashboard, ALB, CloudFront',
});
dashboardStack.addDependency(ecsDevenvStack);

console.log('CC-on-Bedrock CDK App initialized with config:', JSON.stringify(config, null, 2));
