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
  hostedZone: route53.IHostedZone;
  cloudfrontSecret: secretsmanager.Secret;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  litellmAlbDns: string;
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, dashboardEc2Role,
            dashboardCertificateArn, hostedZone, cloudfrontSecret,
            userPool, userPoolClient, litellmAlbDns } = props;

    // Security Group
    const albSg = new ec2.SecurityGroup(this, 'DashboardAlbSg', {
      vpc, description: 'Dashboard ALB SG', allowAllOutbound: true,
    });
    // Note: pl-22a6434b is the CloudFront managed prefix list for ap-northeast-2
    albSg.addIngressRule(ec2.Peer.prefixList('pl-22a6434b'), ec2.Port.tcp(443), 'Allow CloudFront');

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
        'curl -fsSL "https://nodejs.org/dist/v20.18.3/node-v20.18.3-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz',
        'tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1',
        'rm /tmp/node.tar.gz',
        '',
        '# Install PM2',
        'npm install -g pm2',
        '',
        '# Deploy Next.js app from S3',
        'mkdir -p /opt/dashboard',
        'aws s3 cp s3://cc-on-bedrock-deploy-061525506239/dashboard/dashboard-app.tar.gz /tmp/dashboard-app.tar.gz --region ap-northeast-2',
        'tar xzf /tmp/dashboard-app.tar.gz -C /opt/dashboard',
        'rm /tmp/dashboard-app.tar.gz',
        '',
        '# Fetch LiteLLM master key from Secrets Manager',
        `LITELLM_KEY=$(aws secretsmanager get-secret-value --secret-id cc-on-bedrock/litellm-master-key --region ap-northeast-2 --query SecretString --output text 2>/dev/null || echo "")`,
        '',
        '# Environment config',
        'cat > /opt/dashboard/.env << ENVEOF',
        `NEXTAUTH_URL=https://ccbaedrock-dashboard.${config.domainName}`,
        'NEXTAUTH_SECRET=$(openssl rand -hex 32)',
        `COGNITO_CLIENT_ID=${userPoolClient.userPoolClientId}`,
        `COGNITO_ISSUER=https://cognito-idp.ap-northeast-2.amazonaws.com/${userPool.userPoolId}`,
        `LITELLM_API_URL=http://${litellmAlbDns}:4000`,
        'LITELLM_MASTER_KEY=$LITELLM_KEY',
        'AWS_REGION=ap-northeast-2',
        'ECS_CLUSTER_NAME=cc-on-bedrock-devenv',
        `COGNITO_USER_POOL_ID=${userPool.userPoolId}`,
        `DOMAIN_NAME=${config.domainName}`,
        `DEV_SUBDOMAIN=${config.devSubdomain}`,
        'PORT=3000',
        'HOSTNAME=0.0.0.0',
        'ENVEOF',
        '',
        '# Start Next.js',
        'cd /opt/dashboard',
        'pm2 start server.js --name dashboard --env production',
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
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: dashboardCertificateArn
            ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
            : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            'X-Custom-Secret': cloudfrontSecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      comment: 'CC-on-Bedrock Dashboard',
    });

    // Route 53 Record
    new route53.ARecord(this, 'DashboardRecord', {
      zone: hostedZone,
      recordName: 'cconbedrock-dashboard',
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // Outputs
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://cconbedrock-dashboard.${config.domainName}`,
      exportName: 'cc-dashboard-url',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      exportName: 'cc-dashboard-cf-domain',
    });
  }
}
