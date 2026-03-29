import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface DashboardStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  dashboardEc2Role: iam.Role;
  dashboardCertificateArn?: string;
  cloudfrontCertificateArn?: string;  // ACM cert in us-east-1 for CloudFront custom domain
  hostedZone?: route53.IHostedZone;
  userPool: cognito.UserPool;
  sgOpen: ec2.ISecurityGroup;
  sgRestricted: ec2.ISecurityGroup;
  sgLocked: ec2.ISecurityGroup;
  efsFileSystemId: string;
  webAclArn?: string;
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, dashboardEc2Role,
            dashboardCertificateArn, cloudfrontCertificateArn,
            userPool, webAclArn } = props;

    // Import hosted zone directly (avoids cross-stack export dependency on Network stack)
    const hostedZone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.domainName,
        })
      : props.hostedZone!;

    // S3 Deploy Bucket for dashboard app artifacts
    const deployBucketName = `${config.projectPrefix}-deploy-${cdk.Aws.ACCOUNT_ID}`;
    const deployBucket = new s3.Bucket(this, 'DeployBucket', {
      bucketName: deployBucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Use deterministic ARN to avoid cross-stack cyclic reference (dashboardEc2Role is from Security stack)
    const deployBucketArn = `arn:aws:s3:::${deployBucketName}`;
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'DeployBucketRead',
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [deployBucketArn, `${deployBucketArn}/*`],
    }));

    // SSM Parameter Store - read Cognito credentials at boot time
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmParameterRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/cc-on-bedrock/*`],
    }));

    // Dashboard EC2 Role - additional permissions for all dashboard features
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      // Region '*' is required: foundation-model ARNs are region-agnostic,
      // and global.anthropic.claude-* inference profiles route cross-region by design.
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.claude-*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
      ],
    }));
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreAccess',
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:StopRuntimeSession',
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:GetAgentRuntime',
      ],
      resources: ['*'],
    }));
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchAccess',
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'SecurityDashboard',
      actions: [
        'cloudtrail:LookupEvents',
        'route53resolver:ListFirewallRuleGroupAssociations',
        'route53resolver:ListFirewallRules',
        'route53resolver:ListFirewallDomainLists',
        'route53resolver:GetFirewallDomainList',
        'route53resolver:GetFirewallRuleGroup',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
    }));

    // Security Group
    const albSg = new ec2.SecurityGroup(this, 'DashboardAlbSg', {
      vpc, description: 'Dashboard ALB SG', allowAllOutbound: true,
    });
    // CloudFront managed prefix list (region-specific, from config)
    albSg.addIngressRule(ec2.Peer.prefixList(config.cloudfrontPrefixListId), ec2.Port.tcp(443), 'Allow CloudFront');

    const ec2Sg = new ec2.SecurityGroup(this, 'DashboardEc2Sg', {
      vpc, description: 'Dashboard EC2 SG', allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Allow from ALB');

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'DashboardAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // EC2 ASG with Launch Template (Launch Configuration not available in this account)
    const dashboardLaunchTemplate = new ec2.LaunchTemplate(this, 'DashboardLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      role: dashboardEc2Role,
      securityGroup: ec2Sg,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(30, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
      userData: ec2.UserData.custom([
        '#!/bin/bash',
        'set -euo pipefail',
        '',
        '# Install Node.js 20 (direct binary)',
        'ARCH=$(uname -m)',
        'if [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; else NODE_ARCH="x64"; fi',
        `curl -fsSL "https://nodejs.org/dist/${config.nodeVersion}/node-${config.nodeVersion}-linux-\${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz`,
        'tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1',
        'rm /tmp/node.tar.gz',
        '',
        '# Install PM2',
        'npm install -g pm2',
        '',
        '# Deploy Next.js app from S3',
        'mkdir -p /opt/dashboard',
        `aws s3 cp s3://${config.projectPrefix}-deploy-${cdk.Aws.ACCOUNT_ID}/dashboard/dashboard-app.tar.gz /tmp/dashboard-app.tar.gz --region ${cdk.Aws.REGION}`,
        'tar xzf /tmp/dashboard-app.tar.gz -C /opt/dashboard',
        'rm /tmp/dashboard-app.tar.gz',
        '',
        '# Next.js standalone: server.js is in .next/standalone/',
        '# Copy static assets into standalone .next dir for self-contained serving',
        'cp -r /opt/dashboard/.next/static /opt/dashboard/.next/standalone/.next/static',
        '',
        '# Fetch secrets at runtime from SSM Parameter Store (secure, no hardcoding)',
        `NEXTAUTH_SECRET_VAL=$(aws secretsmanager get-secret-value --secret-id cc-on-bedrock/nextauth-secret --region ${cdk.Aws.REGION} --query SecretString --output text 2>/dev/null || openssl rand -hex 32)`,
        `COGNITO_CLIENT_ID_VAL=$(aws ssm get-parameter --name /cc-on-bedrock/cognito/client-id --region ${cdk.Aws.REGION} --query Parameter.Value --output text)`,
        `COGNITO_CLIENT_SECRET_VAL=$(aws ssm get-parameter --name /cc-on-bedrock/cognito/client-secret --region ${cdk.Aws.REGION} --with-decryption --query Parameter.Value --output text)`,
        '',
        '# Environment config (written to standalone dir where server.js runs)',
        'cat > /opt/dashboard/.next/standalone/.env << ENVEOF',
        `NEXTAUTH_URL=https://${config.dashboardSubdomain}.${config.domainName}`,
        'NEXTAUTH_SECRET=$NEXTAUTH_SECRET_VAL',
        'COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID_VAL',
        'COGNITO_CLIENT_SECRET=$COGNITO_CLIENT_SECRET_VAL',
        `COGNITO_ISSUER=https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${userPool.userPoolId}`,
        `AWS_REGION=${cdk.Aws.REGION}`,
        `ECS_CLUSTER_NAME=${config.ecsClusterName}`,
        `COGNITO_USER_POOL_ID=${userPool.userPoolId}`,
        `DOMAIN_NAME=${config.domainName}`,
        `DEV_SUBDOMAIN=${config.devSubdomain}`,
        'PORT=3000',
        'HOSTNAME=0.0.0.0',
        `VPC_ID=${vpc.vpcId}`,
        `AWS_ACCOUNT_ID=${cdk.Aws.ACCOUNT_ID}`,
        `STORAGE_TYPE=${config.storageType}`,
        `NEXT_PUBLIC_STORAGE_TYPE=${config.storageType}`,
        `PRIVATE_SUBNET_IDS=${vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(',')}`,
        `SG_DEVENV_OPEN=${props.sgOpen.securityGroupId}`,
        `SG_DEVENV_RESTRICTED=${props.sgRestricted.securityGroupId}`,
        `SG_DEVENV_LOCKED=${props.sgLocked.securityGroupId}`,
        `S3_SYNC_BUCKET=${config.projectPrefix}-user-data-${cdk.Aws.ACCOUNT_ID}`,
        `EFS_FILE_SYSTEM_ID=${props.efsFileSystemId}`,
        'ROUTING_TABLE=cc-routing-table',
        'ENVEOF',
        'chmod 600 /opt/dashboard/.next/standalone/.env',
        '',
        '# Load env vars and start Next.js from standalone directory',
        'cd /opt/dashboard/.next/standalone',
        'set -a && source .env && set +a',
        'pm2 start server.js --name dashboard',
        'pm2 startup',
        'pm2 save',
      ].join('\n')),
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'DashboardAsg', {
      vpc,
      launchTemplate: dashboardLaunchTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ALB Listener + Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'DashboardTg', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    // ALB access is restricted to CloudFront via Prefix List on SG (no secret header needed)
    if (dashboardCertificateArn) {
      alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(dashboardCertificateArn)],
        defaultTargetGroups: [targetGroup],
      });
    } else {
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });
    }

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'DashboardCf', {
      webAclId: webAclArn,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: dashboardCertificateArn
            ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
            : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      comment: 'CC-on-Bedrock Dashboard',
      ...(cloudfrontCertificateArn ? {
        domainNames: [`${config.dashboardSubdomain}.${config.domainName}`],
        certificate: acm.Certificate.fromCertificateArn(this, 'CfCert', cloudfrontCertificateArn),
      } : {}),
    });

    // Route 53 Record
    new route53.ARecord(this, 'DashboardRecord', {
      zone: hostedZone,
      recordName: config.dashboardSubdomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // Outputs
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${config.dashboardSubdomain}.${config.domainName}`,
      exportName: 'cc-dashboard-url',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      exportName: 'cc-dashboard-cf-domain',
    });
  }
}
