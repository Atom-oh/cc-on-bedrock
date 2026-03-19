import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface LitellmStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  litellmEc2Role: iam.Role;
  litellmMasterKeySecret: secretsmanager.Secret;
  valkeyAuthSecret: secretsmanager.Secret;
}

export class LitellmStack extends cdk.Stack {
  public readonly internalAlb: elbv2.ApplicationLoadBalancer;
  public readonly ecrRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: LitellmStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, litellmEc2Role,
            litellmMasterKeySecret, valkeyAuthSecret } = props;

    // RDS Credentials (created in this stack to avoid cross-stack cyclic reference)
    const rdsCredentialsSecret = new secretsmanager.Secret(this, 'RdsCredentials', {
      secretName: 'cc-on-bedrock/rds-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'litellm_admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
    });
    // Note: litellmEc2Role has broad cc-on-bedrock/* secrets access from Security stack

    // ECR Repository
    this.ecrRepo = new ecr.Repository(this, 'LitellmRepo', {
      repositoryName: 'cc-on-bedrock/litellm',
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Security Groups
    const albSg = new ec2.SecurityGroup(this, 'LitellmAlbSg', {
      vpc,
      description: 'LiteLLM Internal ALB SG',
      allowAllOutbound: true,
    });
    // Only allow from private subnets
    albSg.addIngressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.tcp(4000), 'Allow from VPC');

    const ec2Sg = new ec2.SecurityGroup(this, 'LitellmEc2Sg', {
      vpc,
      description: 'LiteLLM EC2 SG',
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(4000), 'Allow from ALB');

    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc,
      description: 'RDS PostgreSQL SG',
      allowAllOutbound: false,
    });
    rdsSg.addIngressRule(ec2Sg, ec2.Port.tcp(5432), 'Allow from LiteLLM EC2');

    const valkeySg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      description: 'Serverless Valkey SG',
      allowAllOutbound: false,
    });
    valkeySg.addIngressRule(ec2Sg, ec2.Port.tcp(6380), 'Allow from LiteLLM EC2');

    // Internal ALB
    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, 'LitellmAlb', {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // RDS PostgreSQL
    const rdsInstance = new rds.DatabaseInstance(this, 'LitellmDb', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [rdsSg],
      credentials: rds.Credentials.fromSecret(rdsCredentialsSecret),
      databaseName: 'litellm',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: encryptionKey,
      backupRetention: cdk.Duration.days(7),
      multiAz: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // ElastiCache Serverless Valkey
    const valkeySubnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
      description: 'Subnet group for Serverless Valkey',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: 'cc-on-bedrock-valkey',
    });

    const valkeyCache = new elasticache.CfnServerlessCache(this, 'ValkeyCache', {
      engine: 'valkey',
      serverlessCacheName: 'cc-on-bedrock-valkey',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
      securityGroupIds: [valkeySg.securityGroupId],
    });

    // EC2 ASG for LiteLLM
    const launchTemplate = new ec2.LaunchTemplate(this, 'LitellmLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: ec2Sg,
      role: litellmEc2Role,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(50, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          kmsKey: encryptionKey,
        }),
      }],
      userData: ec2.UserData.custom(`#!/bin/bash
set -euo pipefail
yum install -y docker jq
systemctl start docker
systemctl enable docker

# Login to ECR
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

# Pull and run LiteLLM
docker pull $ECR_REGISTRY/cc-on-bedrock/litellm:latest
docker run -d --restart always \\
  --name litellm \\
  -p 4000:4000 \\
  -e AWS_DEFAULT_REGION=$REGION \\
  -e LITELLM_MASTER_KEY_SECRET_ARN=${litellmMasterKeySecret.secretArn} \\
  -e RDS_CREDENTIALS_SECRET_ARN=${rdsCredentialsSecret.secretArn} \\
  -e VALKEY_AUTH_SECRET_ARN=${valkeyAuthSecret.secretArn} \\
  -e REDIS_HOST=$(aws elasticache describe-serverless-caches --serverless-cache-name cc-on-bedrock-valkey --query 'ServerlessCaches[0].Endpoint.Address' --output text) \\
  $ECR_REGISTRY/cc-on-bedrock/litellm:latest
`),
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'LitellmAsg', {
      vpc,
      launchTemplate,
      minCapacity: 2,
      maxCapacity: 4,
      desiredCapacity: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheck: autoscaling.HealthCheck.elb({ grace: cdk.Duration.seconds(120) }),
    });

    // ALB Target Group + Listener
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'LitellmTg', {
      vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: {
        path: '/health/liveness',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    this.internalAlb.addListener('LitellmListener', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // Outputs
    new cdk.CfnOutput(this, 'InternalAlbDns', {
      value: this.internalAlb.loadBalancerDnsName,
      exportName: 'cc-litellm-alb-dns',
    });
    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: rdsInstance.dbInstanceEndpointAddress,
      exportName: 'cc-rds-endpoint',
    });
  }
}
