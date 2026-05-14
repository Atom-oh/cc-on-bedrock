import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as path from 'path';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface DashboardStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  dashboardCertificateArn?: string;
  cloudfrontCertificateArn?: string;
  unifiedCertificateArn?: string;
  hostedZone?: route53.IHostedZone;
  userPool: cognito.UserPool;
  sgOpen: ec2.ISecurityGroup;
  sgRestricted: ec2.ISecurityGroup;
  sgLocked: ec2.ISecurityGroup;
  ecsInfrastructureRoleArn?: string;
  webAclArn?: string;
  dnsFirewallRuleGroupId?: string;
  nlbDnsName: string;
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey,
            dashboardCertificateArn, cloudfrontCertificateArn,
            userPool, webAclArn, nlbDnsName } = props;
    const unifiedCertArn = props.unifiedCertificateArn;

    // Import hosted zone directly (avoids cross-stack export dependency on Network stack)
    const hostedZone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.domainName,
        })
      : props.hostedZone!;

    // ─── Dashboard Role (import directly — avoids cross-stack export dependency on Security stack) ───
    const dashboardEc2Role = iam.Role.fromRoleName(this, 'ImportedDashboardRole', 'cc-on-bedrock-dashboard-ec2');

    // ─── Dashboard Role Permissions ───

    // SSM Parameter Store - read Cognito credentials
    const dashboardPolicy = new iam.Policy(this, 'DashboardExtraPolicy', {
      roles: [dashboardEc2Role],
    });
    dashboardPolicy.addStatements(new iam.PolicyStatement({
      sid: 'SsmParameterRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/cc-on-bedrock/*`],
    }));

    dashboardPolicy.addStatements(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse', 'bedrock:ConverseStream',
      ],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.claude-*`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
      ],
    }));

    dashboardPolicy.addStatements(new iam.PolicyStatement({
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

    dashboardPolicy.addStatements(new iam.PolicyStatement({
      sid: 'CloudWatchAccess',
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    dashboardPolicy.addStatements(new iam.PolicyStatement({
      sid: 'SecurityDashboard',
      actions: [
        'cloudtrail:LookupEvents',
        'route53resolver:ListFirewallRuleGroupAssociations',
        'route53resolver:ListFirewallRules',
        'route53resolver:ListFirewallDomainLists',
        'route53resolver:ListFirewallDomains',
        'route53resolver:GetFirewallDomainList',
        'route53resolver:GetFirewallRuleGroup',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
    }));
    dashboardPolicy.addStatements(new iam.PolicyStatement({
      sid: 'DlpDnsFirewallManagement',
      actions: [
        'route53resolver:CreateFirewallDomainList',
        'route53resolver:DeleteFirewallDomainList',
        'route53resolver:UpdateFirewallDomains',
        'route53resolver:CreateFirewallRule',
        'route53resolver:DeleteFirewallRule',
        'route53resolver:UpdateFirewallRule',
      ],
      resources: ['*'],
    }));

    // ─── Dashboard Core Permissions (Cognito, ECS, EFS, ELB, Secrets, DynamoDB, KMS, Lambda) ───
    const corePolicy = new iam.Policy(this, 'DashboardCorePolicy', {
      roles: [dashboardEc2Role],
    });
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'CognitoAdmin',
      actions: [
        'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser', 'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDisableUser',
        'cognito-idp:ListUsers',
      ],
      resources: [userPool.userPoolArn],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'EcsManagement',
      actions: [
        'ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:ListTasks',
        'ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition', 'ecs:DeregisterTaskDefinition',
        'ecs:DescribeClusters', 'ecs:ListServices', 'ecs:DescribeServices',
        'ecs:DescribeContainerInstances', 'ecs:ListContainerInstances',
      ],
      resources: ['*'],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'EfsAccess',
      actions: [
        'elasticfilesystem:DescribeFileSystems', 'elasticfilesystem:DescribeMountTargets',
        'elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DescribeAccessPoints',
        'elasticfilesystem:DeleteAccessPoint',
      ],
      resources: ['*'],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'ElbManagement',
      actions: [
        'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:ModifyRule',
      ],
      resources: ['*'],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'SecretsManager',
      actions: [
        'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret',
        'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret',
      ],
      resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/*`],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'DynamoDBAccess',
      actions: [
        'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem',
        'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-on-bedrock-usage`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-routing-table`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-dlp-domain-lists`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-department-budgets`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-instances`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-on-bedrock-approval-requests`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-mcp-catalog`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-dept-mcp-config`,
      ],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'KmsAccess',
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [encryptionKey.keyArn],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'LambdaInvoke',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:cc-on-bedrock-*`],
    }));
    corePolicy.addStatements(new iam.PolicyStatement({
      sid: 'PassRoleEcs',
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-task`],
    }));

    // ─── Security Groups ───
    const albSg = new ec2.SecurityGroup(this, 'DashboardAlbSg', {
      vpc, description: 'Dashboard ALB SG', allowAllOutbound: true,
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(config.cloudfrontPrefixListId),
      dashboardCertificateArn ? ec2.Port.tcp(443) : ec2.Port.tcp(80),
      'Allow CloudFront',
    );

    const taskSg = new ec2.SecurityGroup(this, 'DashboardTaskSg', {
      vpc, description: 'Dashboard ECS Task SG (awsvpc)', allowAllOutbound: true,
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Allow from ALB');

    // ─── ECS Cluster (import by name — avoids cross-stack export) ───
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName: config.ecsClusterName,
      vpc,
      securityGroups: [],
    });

    // ─── Task Execution Role (ECR pull, log writes, secret injection) ───
    const taskExecutionRole = new iam.Role(this, 'DashboardTaskExecutionRole', {
      roleName: 'cc-on-bedrock-dashboard-task-execution',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/*`],
    }));
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/cc-on-bedrock/*`],
    }));
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [encryptionKey.keyArn],
    }));

    // ─── ECR Repository (import existing) ───
    const dashboardRepo = ecr.Repository.fromRepositoryName(this, 'DashboardRepo', 'cc-on-bedrock/dashboard');

    // ─── Log Group ───
    const logGroup = new logs.LogGroup(this, 'DashboardLogGroup', {
      logGroupName: '/cc-on-bedrock/ecs/dashboard',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Task Definition (EC2 + awsvpc for per-task ENI) ───
    const taskDef = new ecs.Ec2TaskDefinition(this, 'DashboardTaskDef', {
      family: 'cc-dashboard',
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole: dashboardEc2Role,
      executionRole: taskExecutionRole,
    });

    const nextAuthSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'NextAuthSecret',
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/nextauth-secret-zk4Tnm`);

    taskDef.addContainer('dashboard', {
      image: ecs.ContainerImage.fromEcrRepository(dashboardRepo, 'latest'),
      cpu: 2048,
      memoryLimitMiB: 7680,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'dashboard' }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        NEXTAUTH_URL: `https://${config.dashboardSubdomain}.${config.domainName}`,
        COGNITO_ISSUER: `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${userPool.userPoolId}`,
        AWS_REGION: cdk.Aws.REGION,
        ECS_CLUSTER_NAME: config.ecsClusterName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        DOMAIN_NAME: config.domainName,
        DEV_SUBDOMAIN: config.devSubdomain,
        VPC_ID: vpc.vpcId,
        AWS_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        COMPUTE_MODE: 'ec2',
        STORAGE_TYPE: 'ec2',
        NEXT_PUBLIC_STORAGE_TYPE: 'ec2',
        INSTANCE_TABLE: 'cc-user-instances',
        LAUNCH_TEMPLATE: 'cc-on-bedrock-devenv',
        PRIVATE_SUBNET_IDS: cdk.Fn.join(',', vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds),
        SG_DEVENV_OPEN: props.sgOpen.securityGroupId,
        SG_DEVENV_RESTRICTED: props.sgRestricted.securityGroupId,
        SG_DEVENV_LOCKED: props.sgLocked.securityGroupId,
        S3_SYNC_BUCKET: `${config.projectPrefix}-user-data-${cdk.Aws.ACCOUNT_ID}`,
        ROUTING_TABLE: 'cc-routing-table',
        DLP_DOMAIN_LIST_TABLE: 'cc-dlp-domain-lists',
        DNS_FIREWALL_RULE_GROUP_ID: props.dnsFirewallRuleGroupId ?? '',
        ECS_INFRASTRUCTURE_ROLE_ARN: props.ecsInfrastructureRoleArn ?? '',
        KMS_KEY_ARN: encryptionKey.keyArn,
        HIBERNATE_ENABLED: 'true',  // ADR-010: EC2 Hibernation support
        COOKIE_DOMAIN: `.${config.domainName}`,  // ADR-013: shared cookie for unified auth
      },
      secrets: {
        NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(nextAuthSecret),
        COGNITO_CLIENT_ID: ecs.Secret.fromSsmParameter(
          ssm.StringParameter.fromStringParameterName(this, 'CognitoClientId', '/cc-on-bedrock/cognito/client-id'),
        ),
        COGNITO_CLIENT_SECRET: ecs.Secret.fromSsmParameter(
          ssm.StringParameter.fromSecureStringParameterAttributes(this, 'CognitoClientSecret', {
            parameterName: '/cc-on-bedrock/cognito/client-secret',
          }),
        ),
      },
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://localhost:3000/api/health\').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(30),
        retries: 3,
      },
    });

    // ─── ECS Service ───
    const service = new ecs.Ec2Service(this, 'DashboardSvc', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{ capacityProvider: 'cc-cp-devenv', weight: 1 }],
      securityGroups: [taskSg],
      enableExecuteCommand: true,
    });

    // ─── ALB ───
    const alb = new elbv2.ApplicationLoadBalancer(this, 'DashboardAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = dashboardCertificateArn
      ? alb.addListener('HttpsListener', {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          certificates: [elbv2.ListenerCertificate.fromArn(dashboardCertificateArn)],
        })
      : alb.addListener('HttpListener', {
          port: 80,
          protocol: elbv2.ApplicationProtocol.HTTP,
        });

    listener.addTargets('DashboardTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({
        containerName: 'dashboard',
        containerPort: 3000,
      })],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    // ─── Lambda@Edge: Unified Auth + Origin Routing (ADR-013) ───
    const devDomain = `${config.devSubdomain}.${config.domainName}`;
    const dashboardUrl = `https://${config.dashboardSubdomain}.${config.domainName}`;

    // NextAuth secret SSM parameter (for session validator to decrypt JWE cookies)
    const nextAuthSecretValue = nextAuthSecret.secretValue.unsafeUnwrap();
    new ssm.StringParameter(this, 'NextAuthSecretParam', {
      parameterName: '/cc-on-bedrock/nextauth-secret',
      description: 'NextAuth secret for Lambda@Edge session validation',
      stringValue: nextAuthSecretValue,
    });

    // Session Validator — validates NextAuth cookie for *.dev.* requests
    const sessionValidatorFn = new cloudfront.experimental.EdgeFunction(this, 'SessionValidator', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/devenv-session-validator'), {
        bundling: {
          image: cdk.DockerImage.fromRegistry('node:20-alpine'),
          command: [
            'sh', '-c',
            `sed -e "s|__DEV_DOMAIN__|${devDomain}|g" \
                 -e "s|__DASHBOARD_URL__|${dashboardUrl}|g" \
                 -e "s|__SSM_REGION__|ap-northeast-2|g" \
                 /asset-input/index.js > /asset-output/index.js`,
          ],
        },
      }),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'NextAuth session validation for *.dev.atomai.click (ADR-013)',
    });
    sessionValidatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:ap-northeast-2:${cdk.Aws.ACCOUNT_ID}:parameter/cc-on-bedrock/nextauth-secret`],
    }));

    // Origin Router — routes *.dev.* to NLB, everything else to ALB (default)
    // NLB DNS and CF secret come from CloudFormation tokens (Fn::ImportValue, Secrets Manager)
    // that only resolve at deploy time, so they CANNOT be baked in via sed at build time.
    // Store them in SSM and load at Lambda runtime (same cold-start caching as session-validator).
    const cloudfrontSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ImportedCfSecret',
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/cloudfront-secret-lZMDiE`);
    const originConfigParam = new ssm.StringParameter(this, 'OriginRouterConfigParam', {
      parameterName: '/cc-on-bedrock/devenv-origin-config',
      description: 'NLB DNS + CF secret for Lambda@Edge origin router (ADR-013)',
      stringValue: cdk.Fn.sub('{"nlbDns":"${NlbDns}","cfSecret":"${CfSecret}"}', {
        NlbDns: nlbDnsName,
        CfSecret: cloudfrontSecret.secretValue.unsafeUnwrap(),
      }),
    });

    const originRouterFn = new cloudfront.experimental.EdgeFunction(this, 'OriginRouter', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/devenv-origin-router'), {
        bundling: {
          image: cdk.DockerImage.fromRegistry('node:20-alpine'),
          command: [
            'sh', '-c',
            `sed -e "s|__DEV_DOMAIN__|${devDomain}|g" \
                 -e "s|__SSM_REGION__|ap-northeast-2|g" \
                 /asset-input/index.js > /asset-output/index.js`,
          ],
        },
      }),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Host-based origin routing for unified CloudFront (ADR-013)',
    });
    originRouterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [originConfigParam.parameterArn],
    }));

    // ─── Unified CloudFront Distribution (Dashboard + DevEnv) ───
    const certArn = unifiedCertArn || cloudfrontCertificateArn;
    const domainNames = certArn
      ? [`${config.dashboardSubdomain}.${config.domainName}`, `*.${config.devSubdomain}.${config.domainName}`]
      : undefined;

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
        edgeLambdas: [
          { eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST, functionVersion: sessionValidatorFn.currentVersion },
          { eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST, functionVersion: originRouterFn.currentVersion },
        ],
      },
      comment: 'CC-on-Bedrock Unified (Dashboard + DevEnv)',
      ...(certArn ? {
        domainNames,
        certificate: acm.Certificate.fromCertificateArn(this, 'CfCert', certArn),
      } : {}),
    });

    // Route 53 Records — Dashboard + DevEnv wildcard (both point to unified CF)
    new route53.ARecord(this, 'DashboardRecord', {
      zone: hostedZone,
      recordName: config.dashboardSubdomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });
    new route53.ARecord(this, 'DevEnvWildcard', {
      zone: hostedZone,
      recordName: `*.${config.devSubdomain}`,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${config.dashboardSubdomain}.${config.domainName}`,
      exportName: 'cc-dashboard-url',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      exportName: 'cc-dashboard-cf-domain',
    });
    new cdk.CfnOutput(this, 'DashboardServiceName', {
      value: service.serviceName,
    });
  }
}
