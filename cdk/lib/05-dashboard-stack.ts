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
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, dashboardEc2Role,
            dashboardCertificateArn, hostedZone, cloudfrontSecret,
            userPool, userPoolClient } = props;

    // Dashboard EC2 Role - additional permissions for all dashboard features
    dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
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
        `aws s3 cp s3://cc-on-bedrock-deploy-${cdk.Aws.ACCOUNT_ID}/dashboard/dashboard-app.tar.gz /tmp/dashboard-app.tar.gz --region ${cdk.Aws.REGION}`,
        'tar xzf /tmp/dashboard-app.tar.gz -C /opt/dashboard',
        'rm /tmp/dashboard-app.tar.gz',
        '',
        '# Fetch secrets from Secrets Manager at runtime (not baked into UserData)',
        `NEXTAUTH_SECRET_VAL=$(aws secretsmanager get-secret-value --secret-id cc-on-bedrock/nextauth-secret --region ${cdk.Aws.REGION} --query SecretString --output text 2>/dev/null || openssl rand -hex 32)`,
        '',
        '# Environment config',
        'cat > /opt/dashboard/.env << ENVEOF',
        `NEXTAUTH_URL=https://${config.dashboardSubdomain}.${config.domainName}`,
        'NEXTAUTH_SECRET=$NEXTAUTH_SECRET_VAL',
        `COGNITO_CLIENT_ID=${userPoolClient.userPoolClientId}`,
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
        'ENVEOF',
        'chmod 600 /opt/dashboard/.env',
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
      const httpsListener = alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(dashboardCertificateArn)],
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Forbidden',
        }),
      });
      // Only allow traffic with valid X-Custom-Secret header from CloudFront
      new elbv2.ApplicationListenerRule(this, 'DashboardSecretRule', {
        listener: httpsListener,
        priority: 1,
        conditions: [
          elbv2.ListenerCondition.httpHeader('X-Custom-Secret', [cloudfrontSecret.secretValue.unsafeUnwrap()]),
        ],
        targetGroups: [targetGroup],
      });
    } else {
      const httpListener = alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Forbidden',
        }),
      });
      new elbv2.ApplicationListenerRule(this, 'DashboardSecretRule', {
        listener: httpListener,
        priority: 1,
        conditions: [
          elbv2.ListenerCondition.httpHeader('X-Custom-Secret', [cloudfrontSecret.secretValue.unsafeUnwrap()]),
        ],
        targetGroups: [targetGroup],
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
