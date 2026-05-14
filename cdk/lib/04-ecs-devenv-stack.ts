import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as fs from 'fs';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface EcsDevenvStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  taskPermissionBoundary?: iam.IManagedPolicy;
  webAclArn?: string;
  /** ADR-016: us-east-1 ACM certificate ARN covering *.{devSubdomain}.{domain}.
   *  Required to attach a custom domain to the DevEnv CloudFront distribution.
   *  When omitted, the DevEnv distribution skips alias config (default CF domain only). */
  devenvCertificateArn?: string;
  /** Hosted zone for *.dev record. If omitted, looked up from config.hostedZoneId. */
  hostedZone?: route53.IHostedZone;
}

export class EcsDevenvStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly ecrRepo: ecr.IRepository;
  public readonly sgOpen: ec2.SecurityGroup;
  public readonly sgRestricted: ec2.SecurityGroup;
  public readonly sgLocked: ec2.SecurityGroup;
  constructor(scope: Construct, id: string, props: EcsDevenvStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, webAclArn } = props;

    // Import CloudFront secret (Nginx validates X-Custom-Secret from CloudFront)
    const cloudfrontSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ImportedCfSecret',
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/cloudfront-secret-lZMDiE`);

    // ECS Task Role (created in this stack to avoid cross-stack cyclic references)
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: 'cc-on-bedrock-ecs-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ...(props.taskPermissionBoundary ? { permissionsBoundary: props.taskPermissionBoundary } : {}),
    });
    // Bedrock: All Claude models — wildcard prefix covers global./apac./us./eu./bare anthropic (ADR-021)
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
      ],
    }));
    // SSM permissions for ECS Exec
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));
    // CloudWatch: publish custom idle metrics from idle-monitor.sh (CC/DevEnv namespace)
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': 'CC/DevEnv' },
      },
    }));

    // ECS Task Execution Role
    const ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      roleName: 'cc-on-bedrock-ecs-task-execution',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });
    ecsTaskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/*`],
    }));

    // ECR Repository (import existing - was created with RETAIN policy)
    this.ecrRepo = ecr.Repository.fromRepositoryName(this, 'DevenvRepo', 'cc-on-bedrock/devenv');

    // S3 Bucket for user workspace data (import existing - was created with RETAIN policy)
    const userDataBucket = s3.Bucket.fromBucketAttributes(this, 'UserDataBucket', {
      bucketName: `cc-on-bedrock-user-data-${cdk.Aws.ACCOUNT_ID}`,
      encryptionKey,
    });

    // DLP Security Groups
    this.sgOpen = new ec2.SecurityGroup(this, 'DevenvSgOpen', {
      vpc, description: 'DLP: Open - all outbound', allowAllOutbound: true,
    });
    this.sgRestricted = new ec2.SecurityGroup(this, 'DevenvSgRestricted', {
      vpc, description: 'DLP: Restricted - whitelist outbound', allowAllOutbound: false,
    });
    this.sgRestricted.addEgressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.allTraffic(), 'Allow VPC internal');
    this.sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS for whitelisted domains');

    this.sgLocked = new ec2.SecurityGroup(this, 'DevenvSgLocked', {
      vpc, description: 'DLP: Locked - VPC only', allowAllOutbound: false,
    });
    this.sgLocked.addEgressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.allTraffic(), 'Allow VPC internal only');

    // Local aliases for convenience
    const sgOpen = this.sgOpen;
    const sgRestricted = this.sgRestricted;
    const sgLocked = this.sgLocked;

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'DevenvCluster', {
      vpc,
      clusterName: config.ecsClusterName,
      containerInsights: true,
    });

    // ECS Capacity Provider — in EC2 compute mode, only Dashboard runs here
    // so a smaller instance type suffices (set via config.ecsHostInstanceType)
    const ecsInstanceRole = new iam.Role(this, 'EcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    // No Bedrock on Instance Role — containers MUST use per-user Task Role
    // IMDS blocked via ECS_AWSVPC_BLOCK_IMDS + IMDSv2 hop limit

    const ecsLaunchTemplate = new ec2.LaunchTemplate(this, 'EcsCapacityLaunchTemplate', {
      instanceType: new ec2.InstanceType(config.ecsHostInstanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
      role: ecsInstanceRole,
      securityGroup: sgOpen,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
      userData: ec2.UserData.forLinux(),
    });
    // ECS agent config: cluster + awsvpc + IMDS block
    ecsLaunchTemplate.userData!.addCommands(
      `echo ECS_CLUSTER=${this.cluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_ENABLE_TASK_ENI=true >> /etc/ecs/ecs.config',
      'echo ECS_AWSVPC_BLOCK_IMDS=true >> /etc/ecs/ecs.config',
      'echo ECS_IMAGE_PULL_BEHAVIOR=always >> /etc/ecs/ecs.config',
    );

    // ─── Single multi-AZ ASG + Capacity Provider ───
    // EBS snapshots are region-level, so AZ pinning is unnecessary.
    const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
      vpc,
      launchTemplate: ecsLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 2,  // Dashboard only in EC2 mode
      desiredCapacity: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      newInstancesProtectedFromScaleIn: false,
    });

    asg.addLifecycleHook('TerminationHook', {
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      heartbeatTimeout: cdk.Duration.minutes(10),
      defaultResult: autoscaling.DefaultResult.CONTINUE,
    });

    const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    cfnAsg.terminationPolicies = ['OldestInstance'];

    const cp = new ecs.AsgCapacityProvider(this, 'EcsCp', {
      capacityProviderName: 'cc-cp-devenv',
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      targetCapacityPercent: 80,
      instanceWarmupPeriod: 300,
    });
    this.cluster.addAsgCapacityProvider(cp);

    // Log Group
    const logGroup = new logs.LogGroup(this, 'DevenvLogGroup', {
      logGroupName: '/cc-on-bedrock/ecs/devenv',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DevEnv task definitions removed — EC2-per-user mode (Stack 07)
    // ECS cluster retained for Dashboard + Nginx services only

    // ─── Nginx Security Group ───
    const nginxSg = new ec2.SecurityGroup(this, 'NginxSg', {
      vpc,
      description: 'Nginx reverse proxy SG',
      allowAllOutbound: true,
    });
    nginxSg.addIngressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.tcp(80), 'Allow NLB + VPC traffic on port 80');

    // Allow Nginx → DevEnv containers on port 8080
    [sgOpen, sgRestricted, sgLocked].forEach(sg => {
      sg.addIngressRule(nginxSg, ec2.Port.tcp(8080), 'Allow from Nginx proxy');
    });

    // ─── Network Load Balancer (internet-facing for CloudFront access) ───
    const nlbSg = new ec2.SecurityGroup(this, 'NlbSg', {
      vpc,
      description: 'NLB SG - allow CloudFront only',
      allowAllOutbound: true,
    });
    nlbSg.addIngressRule(
      ec2.Peer.prefixList(config.cloudfrontPrefixListId),
      ec2.Port.tcp(80),
      'Allow CloudFront HTTP'
    );

    const nlb = new elbv2.NetworkLoadBalancer(this, 'DevenvNlb', {
      vpc,
      internetFacing: true,
      crossZoneEnabled: true,
      securityGroups: [nlbSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ============================================================
    // NLB + Nginx Dynamic Routing (Enterprise - unlimited users)
    // Replaces ALB listener rules (100 rule limit) with Nginx
    // ============================================================

    // DynamoDB Routing Table for dynamic Nginx config
    // Schema: PK=subdomain, container_ip, port, status, updated_at
    const routingTable = new dynamodb.Table(this, 'RoutingTable', {
      tableName: 'cc-routing-table',
      partitionKey: { name: 'subdomain', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Nginx Config Generator Lambda (triggered by DynamoDB Stream)
    // Generates nginx.conf from routing table and uploads to S3
    const nginxConfigLambda = new lambda.Function(this, 'NginxConfigLambda', {
      functionName: 'cc-on-bedrock-nginx-config-gen',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'nginx-config-gen.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ROUTING_TABLE: routingTable.tableName,
        CONFIG_BUCKET: userDataBucket.bucketName,
        CONFIG_KEY: 'nginx/nginx.conf',
        DEV_DOMAIN: `${config.devSubdomain}.${config.domainName}`,
        REGION: cdk.Aws.REGION,
        CLOUDFRONT_SECRET: cloudfrontSecret.secretValue.unsafeUnwrap(),
      },
    });

    // Grant Lambda permissions
    routingTable.grantReadData(nginxConfigLambda);
    userDataBucket.grantWrite(nginxConfigLambda);

    // DynamoDB Stream -> Lambda trigger
    nginxConfigLambda.addEventSource(new lambdaEventSources.DynamoEventSource(routingTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      retryAttempts: 3,
    }));

    // ─── Nginx Task Role (minimal — S3 config read only, no Bedrock) ───
    const nginxTaskRole = new iam.Role(this, 'NginxTaskRole', {
      roleName: 'cc-on-bedrock-nginx-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    nginxTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket', 's3:HeadObject'],
      resources: [
        userDataBucket.bucketArn,
        `${userDataBucket.bucketArn}/*`,
      ],
    }));
    // KMS decrypt for reading KMS-encrypted S3 objects
    encryptionKey.grantDecrypt(nginxTaskRole);

    // ─── Nginx Reverse Proxy Task Definition (Fargate — lightweight, cost-efficient) ───
    const nginxTaskDef = new ecs.FargateTaskDefinition(this, 'NginxTaskDef', {
      family: 'cc-nginx-proxy',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: nginxTaskRole,
      executionRole: ecsTaskExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const nginxImage = ecs.ContainerImage.fromEcrRepository(
      ecr.Repository.fromRepositoryName(this, 'NginxRepo', 'cc-on-bedrock/nginx'),
    );

    nginxTaskDef.addContainer('nginx', {
      image: nginxImage,
      essential: true,
      environment: {
        CONFIG_BUCKET: userDataBucket.bucketName,
        CONFIG_KEY: 'nginx/nginx.conf',
        RELOAD_INTERVAL: '5',
        AWS_DEFAULT_REGION: cdk.Aws.REGION,
        AWS_REGION: cdk.Aws.REGION,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: new logs.LogGroup(this, 'NginxLogGroup', {
          logGroupName: '/cc-on-bedrock/ecs/nginx',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        streamPrefix: 'nginx',
      }),
      portMappings: [{ containerPort: 80, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:80/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // ─── Nginx ECS Service (Fargate — $18/month vs $800/month EC2 idle) ───
    const nginxService = new ecs.FargateService(this, 'NginxService', {
      cluster: this.cluster,
      taskDefinition: nginxTaskDef,
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      securityGroups: [nginxSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
    });

    const nlbListener = nlb.addListener('NlbListener', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
    });

    nlbListener.addTargets('NginxTargets', {
      port: 80,
      targets: [nginxService],
      healthCheck: {
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(15),
      },
    });

    // Grant Nginx S3 read access for config
    userDataBucket.grantRead(ecsTaskRole);

    // ─── DevEnv CloudFront (ADR-016) ────────────────────────────
    // Separate distribution for *.dev.<domain>. NLB origin with X-Custom-Secret
    // injection. session-validator Lambda@Edge enforces NextAuth cookie.
    const devDomain = `${config.devSubdomain}.${config.domainName}`;
    const dashboardUrl = `https://${config.dashboardSubdomain}.${config.domainName}`;

    // Pre-substitute template placeholders at synth time (no docker bundling required).
    // Result is written to .gen/<stack>/devenv-session-validator/index.js and picked up
    // by lambda.Code.fromAsset.
    const validatorSrc = fs.readFileSync(
      path.join(__dirname, 'lambda/devenv-session-validator/index.js'),
      'utf8',
    )
      .replace(/__DEV_DOMAIN__/g, devDomain)
      .replace(/__DASHBOARD_URL__/g, dashboardUrl)
      .replace(/__SSM_REGION__/g, 'ap-northeast-2');
    const validatorOutDir = path.join(__dirname, '.gen', 'ecs-devenv', 'devenv-session-validator');
    fs.mkdirSync(validatorOutDir, { recursive: true });
    fs.writeFileSync(path.join(validatorOutDir, 'index.js'), validatorSrc);

    const sessionValidatorFn = new cloudfront.experimental.EdgeFunction(this, 'DevenvSessionValidator', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(validatorOutDir),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'NextAuth session validator for *.dev.<domain> (ADR-016)',
    });
    // Lambda@Edge reads the NextAuth secret SSM parameter (created in Stack 05)
    sessionValidatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:ap-northeast-2:${cdk.Aws.ACCOUNT_ID}:parameter/cc-on-bedrock/nextauth-secret`],
    }));

    const devenvCert = props.devenvCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'DevenvCfCert', props.devenvCertificateArn)
      : undefined;

    // ADR-016 v2: construct ID 'DevenvCfV2' (not 'DevenvCf') — old physical resource
    // E1ZJ5UWCRSNA9D was deleted out-of-band on 2026-05-12. Renaming forces CFN to
    // CREATE a new distribution instead of trying to UpdateDistribution on a missing one.
    const devenvDistribution = new cloudfront.Distribution(this, 'DevenvCfV2', {
      webAclId: props.webAclArn,
      defaultBehavior: {
        // NLB origin; Nginx validates X-Custom-Secret to reject non-CF traffic
        origin: new origins.HttpOrigin(nlb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            'X-Custom-Secret': cloudfrontSecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        edgeLambdas: [
          { eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST, functionVersion: sessionValidatorFn.currentVersion },
        ],
      },
      comment: 'CC-on-Bedrock DevEnv (*.dev.<domain>) — ADR-016 split',
      ...(devenvCert ? {
        domainNames: [`*.${config.devSubdomain}.${config.domainName}`],
        certificate: devenvCert,
      } : {}),
    });

    // Route 53 *.dev.<domain> wildcard alias (moved from Stack 05 per ADR-016)
    const hostedZone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZoneForDevenv', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.domainName,
        })
      : props.hostedZone;
    if (hostedZone) {
      new route53.ARecord(this, 'DevEnvWildcard', {
        zone: hostedZone,
        recordName: `*.${config.devSubdomain}`,
        target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(devenvDistribution)),
      });
    }

    new cdk.CfnOutput(this, 'DevenvCfDomainSplit', {
      value: devenvDistribution.distributionDomainName,
      description: 'DevEnv CloudFront distribution domain (ADR-016 split)',
      // Intentionally no exportName — avoids collision with legacy export
      // 'cc-devenv-cf-domain' still resident in deployed Stack 04 state.
    });

    // Outputs
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName, exportName: 'cc-ecs-cluster-name' });
    new cdk.CfnOutput(this, 'SgOpen', { value: sgOpen.securityGroupId, exportName: 'cc-sg-devenv-open' });
    new cdk.CfnOutput(this, 'SgRestricted', { value: sgRestricted.securityGroupId, exportName: 'cc-sg-devenv-restricted' });
    new cdk.CfnOutput(this, 'SgLocked', { value: sgLocked.securityGroupId, exportName: 'cc-sg-devenv-locked' });
    new cdk.CfnOutput(this, 'UserDataBucketName', { value: userDataBucket.bucketName });

    // NLB + Nginx routing outputs
    new cdk.CfnOutput(this, 'RoutingTableName', { value: routingTable.tableName, exportName: 'cc-routing-table-name' });
    new cdk.CfnOutput(this, 'NginxConfigLambdaArn', { value: nginxConfigLambda.functionArn });
    new cdk.CfnOutput(this, 'NlbDnsName', { value: nlb.loadBalancerDnsName, exportName: 'cc-devenv-nlb-dns' });
  }
}
