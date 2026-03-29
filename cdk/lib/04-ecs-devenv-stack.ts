import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface EcsDevenvStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  hostedZone: route53.IHostedZone;
  cloudfrontSecret: secretsmanager.Secret;
}

export class EcsDevenvStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly ecrRepo: ecr.Repository;
  public readonly routingTable: dynamodb.Table;
  public readonly nlb: elbv2.NetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: EcsDevenvStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey, hostedZone, cloudfrontSecret } = props;

    // ─── IAM Roles ───

    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: 'cc-on-bedrock-ecs-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-*`,
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/apac.anthropic.claude-*`,
      ],
    }));
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

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

    // ─── ECR Repository ───

    this.ecrRepo = new ecr.Repository(this, 'DevenvRepo', {
      repositoryName: 'cc-on-bedrock/devenv',
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── EFS File System ───

    const fileSystem = new efs.FileSystem(this, 'DevenvEfs', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      kmsKey: encryptionKey,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── DLP Security Groups ───

    const sgOpen = new ec2.SecurityGroup(this, 'DevenvSgOpen', {
      vpc, description: 'DLP: Open - all outbound', allowAllOutbound: true,
    });
    const sgRestricted = new ec2.SecurityGroup(this, 'DevenvSgRestricted', {
      vpc, description: 'DLP: Restricted - whitelist outbound', allowAllOutbound: false,
    });
    sgRestricted.addEgressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.allTraffic(), 'Allow VPC internal');
    sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS for whitelisted domains');

    const sgLocked = new ec2.SecurityGroup(this, 'DevenvSgLocked', {
      vpc, description: 'DLP: Locked - VPC only', allowAllOutbound: false,
    });
    sgLocked.addEgressRule(ec2.Peer.ipv4(config.vpcCidr), ec2.Port.allTraffic(), 'Allow VPC internal only');

    [sgOpen, sgRestricted, sgLocked].forEach(sg => {
      fileSystem.connections.allowFrom(sg, ec2.Port.tcp(2049), 'Allow EFS from devenv');
    });

    // ─── ECS Cluster ───

    this.cluster = new ecs.Cluster(this, 'DevenvCluster', {
      vpc,
      clusterName: config.ecsClusterName,
      containerInsights: true,
    });

    // ECS Capacity Provider (EC2 ASG)
    const ecsInstanceRole = new iam.Role(this, 'EcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    ecsInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));

    const ecsLaunchTemplate = new ec2.LaunchTemplate(this, 'EcsCapacityLaunchTemplate', {
      instanceType: new ec2.InstanceType(config.ecsHostInstanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
      role: ecsInstanceRole,
      securityGroup: sgOpen,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
      userData: ec2.UserData.forLinux(),
    });
    ecsLaunchTemplate.userData!.addCommands(
      `echo ECS_CLUSTER=${this.cluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_ENABLE_TASK_ENI=true >> /etc/ecs/ecs.config',
    );

    const capacityAsg = new autoscaling.AutoScalingGroup(this, 'EcsCapacityAsg', {
      vpc,
      launchTemplate: ecsLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 15,
      desiredCapacity: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      newInstancesProtectedFromScaleIn: false,
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, 'EcsCapacityProvider', {
      autoScalingGroup: capacityAsg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      targetCapacityPercent: 80,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);

    // ─── Log Group ───

    const logGroup = new logs.LogGroup(this, 'DevenvLogGroup', {
      logGroupName: '/cc-on-bedrock/ecs/devenv',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Task Definitions (6 variants: 2 OS x 3 tiers) ───

    const tiers = [
      { name: 'light', cpu: 1024, memory: 4096 },
      { name: 'standard', cpu: 2048, memory: 8192 },
      { name: 'power', cpu: 4096, memory: 12288 },
    ];
    const osVariants = ['ubuntu', 'al2023'];

    for (const os of osVariants) {
      for (const tier of tiers) {
        const taskDef = new ecs.Ec2TaskDefinition(this, `TaskDef-${os}-${tier.name}`, {
          family: `devenv-${os}-${tier.name}`,
          networkMode: ecs.NetworkMode.AWS_VPC,
          taskRole: ecsTaskRole,
          executionRole: ecsTaskExecutionRole,
        });

        const container = taskDef.addContainer('devenv', {
          image: ecs.ContainerImage.fromRegistry(
            `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/cc-on-bedrock/devenv:${os}-latest`
          ),
          cpu: tier.cpu,
          memoryLimitMiB: tier.memory,
          essential: true,
          logging: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: `${os}-${tier.name}`,
          }),
          environment: {
            AWS_DEFAULT_REGION: cdk.Aws.REGION,
            AWS_REGION: cdk.Aws.REGION,
            SECURITY_POLICY: 'open',
          },
          portMappings: [{ containerPort: 8080 }],
          linuxParameters: new ecs.LinuxParameters(this, `LinuxParams-${os}-${tier.name}`, {
            initProcessEnabled: true,
          }),
        });

        taskDef.addVolume({
          name: 'efs-workspace',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/',
            transitEncryption: 'ENABLED',
          },
        });

        container.addMountPoints({
          sourceVolume: 'efs-workspace',
          containerPath: '/home/coder',
          readOnly: false,
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // NLB + Nginx Routing (replaces ALB — unlimited users, L4+L7)
    // Flow: CloudFront → NLB → Nginx → ECS Containers
    // ═══════════════════════════════════════════════════════════════

    // ─── DynamoDB Routing Table ───

    this.routingTable = new dynamodb.Table(this, 'RoutingTable', {
      tableName: 'cc-routing-table',
      partitionKey: { name: 'subdomain', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── S3 Bucket for Nginx Config ───

    const configBucket = new s3.Bucket(this, 'NginxConfigBucket', {
      bucketName: `cc-on-bedrock-nginx-config-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ─── Nginx Config Generator Lambda ───

    const nginxConfigLambda = new lambda.Function(this, 'NginxConfigGen', {
      functionName: 'cc-nginx-config-gen',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'nginx-config-gen.handler',
      code: lambda.Code.fromAsset('lib/lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ROUTING_TABLE: this.routingTable.tableName,
        CONFIG_BUCKET: configBucket.bucketName,
        CONFIG_KEY: 'nginx/nginx.conf',
        DEV_DOMAIN: `${config.devSubdomain}.${config.domainName}`,
        CLOUDFRONT_SECRET: cloudfrontSecret.secretValue.unsafeUnwrap(),
      },
    });

    this.routingTable.grantReadData(nginxConfigLambda);
    configBucket.grantWrite(nginxConfigLambda);

    // Trigger Lambda on DynamoDB Stream changes
    nginxConfigLambda.addEventSource(new lambdaEventSources.DynamoEventSource(this.routingTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      retryAttempts: 3,
    }));

    // ─── Nginx Security Group ───

    const nginxSg = new ec2.SecurityGroup(this, 'NginxSg', {
      vpc, description: 'Nginx router SG', allowAllOutbound: true,
    });
    // NLB preserves client IP (CloudFront IPs). Allow port 80 from anywhere
    // since NLB has no SG. Nginx validates X-Custom-Secret header.
    nginxSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow NLB traffic (Nginx validates X-Custom-Secret)');

    // Allow Nginx → DevEnv containers on port 8080
    [sgOpen, sgRestricted, sgLocked].forEach(sg => {
      sg.addIngressRule(nginxSg, ec2.Port.tcp(8080), 'Allow from Nginx router');
    });

    // ─── Nginx ECS Task Definition ───

    const nginxTaskDef = new ecs.Ec2TaskDefinition(this, 'NginxTaskDef', {
      family: 'cc-nginx-router',
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole: ecsTaskExecutionRole,
    });

    const nginxContainer = nginxTaskDef.addContainer('nginx', {
      image: ecs.ContainerImage.fromRegistry(
        `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/cc-on-bedrock/nginx:latest`
      ),
      cpu: 512,
      memoryLimitMiB: 1024,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'nginx',
      }),
      environment: {
        CONFIG_BUCKET: configBucket.bucketName,
        CONFIG_KEY: 'nginx/nginx.conf',
        RELOAD_INTERVAL: '5',
      },
      portMappings: [{ containerPort: 80 }],
    });

    // Nginx task needs S3 read access for config polling
    nginxTaskDef.taskRole?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:HeadObject'],
      resources: [configBucket.arnForObjects('*')],
    }));
    nginxTaskDef.taskRole?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [configBucket.bucketArn],
    }));

    // ─── Nginx ECS Service ───

    const nginxService = new ecs.Ec2Service(this, 'NginxService', {
      cluster: this.cluster,
      taskDefinition: nginxTaskDef,
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      securityGroups: [nginxSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Auto Scaling: 2-4 Nginx tasks based on CPU utilization
    const nginxScaling = nginxService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 });
    nginxScaling.scaleOnCpuUtilization('NginxCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ─── NLB (replaces ALB) ───

    this.nlb = new elbv2.NetworkLoadBalancer(this, 'DevenvNlb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: 'cc-devenv-nlb',
    });

    const nlbListener = this.nlb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
    });

    nlbListener.addTargets('NginxTargets', {
      port: 80,
      targets: [nginxService.loadBalancerTarget({
        containerName: 'nginx',
        containerPort: 80,
      })],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        path: '/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // ─── CloudFront Distribution ───

    const distribution = new cloudfront.Distribution(this, 'DevenvCf', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(this.nlb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
          customHeaders: {
            'X-Custom-Secret': cloudfrontSecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      comment: 'CC-on-Bedrock Dev Environment (NLB+Nginx)',
    });

    // ─── Route 53 Wildcard Record ───

    new route53.ARecord(this, 'DevEnvWildcard', {
      zone: hostedZone,
      recordName: `*.${config.devSubdomain}`,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // ─── Outputs ───

    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName, exportName: 'cc-ecs-cluster-name' });
    new cdk.CfnOutput(this, 'EfsId', { value: fileSystem.fileSystemId, exportName: 'cc-efs-id' });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName, exportName: 'cc-devenv-cf-domain' });
    new cdk.CfnOutput(this, 'RoutingTableName', { value: this.routingTable.tableName, exportName: 'cc-routing-table-name' });
    new cdk.CfnOutput(this, 'NginxConfigBucketName', { value: configBucket.bucketName, exportName: 'cc-nginx-config-bucket' });
    new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlb.loadBalancerDnsName, exportName: 'cc-devenv-nlb-dns' });
    new cdk.CfnOutput(this, 'SgOpen', { value: sgOpen.securityGroupId, exportName: 'cc-sg-devenv-open' });
    new cdk.CfnOutput(this, 'SgRestricted', { value: sgRestricted.securityGroupId, exportName: 'cc-sg-devenv-restricted' });
    new cdk.CfnOutput(this, 'SgLocked', { value: sgLocked.securityGroupId, exportName: 'cc-sg-devenv-locked' });
  }
}
