#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { defaultConfig } from '../config/default';
import { NetworkStack } from '../lib/01-network-stack';
import { SecurityStack } from '../lib/02-security-stack';
import { LitellmStack } from '../lib/03-litellm-stack';
import { EcsDevenvStack } from '../lib/04-ecs-devenv-stack';

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

// Stack 03: LiteLLM
const litellmStack = new LitellmStack(app, 'CcOnBedrock-LiteLLM', {
  env, config,
  vpc: networkStack.vpc,
  encryptionKey: securityStack.encryptionKey,
  litellmEc2Role: securityStack.litellmEc2Role,
  litellmMasterKeySecret: securityStack.litellmMasterKeySecret,
  rdsCredentialsSecret: securityStack.rdsCredentialsSecret,
  valkeyAuthSecret: securityStack.valkeyAuthSecret,
  description: 'CC-on-Bedrock: LiteLLM Proxy, RDS, Serverless Valkey',
});
litellmStack.addDependency(securityStack);

// Stack 04: ECS Dev Environment
const ecsDevenvStack = new EcsDevenvStack(app, 'CcOnBedrock-EcsDevenv', {
  env, config,
  vpc: networkStack.vpc,
  encryptionKey: securityStack.encryptionKey,
  ecsTaskRole: securityStack.ecsTaskRole,
  ecsTaskExecutionRole: securityStack.ecsTaskExecutionRole,
  litellmAlbDns: litellmStack.internalAlb.loadBalancerDnsName,
  devEnvCertificate: securityStack.devEnvCertificate,
  hostedZone: networkStack.hostedZone,
  cloudfrontSecret: securityStack.cloudfrontSecret,
  description: 'CC-on-Bedrock: ECS Cluster, Task Definitions, EFS, CloudFront',
});
ecsDevenvStack.addDependency(litellmStack);

console.log('CC-on-Bedrock CDK App initialized with config:', JSON.stringify(config, null, 2));
