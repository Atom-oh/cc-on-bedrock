import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface EcsDevenvStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  devEnvCertificateArn?: string;
  hostedZone: route53.IHostedZone;
  cloudfrontSecret: secretsmanager.Secret;
}

export class EcsDevenvStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly ecrRepo: ecr.Repository;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: EcsDevenvStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey,
            devEnvCertificateArn, hostedZone, cloudfrontSecret } = props;

    // ECS Task Role (created in this stack to avoid cross-stack cyclic references)
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: 'cc-on-bedrock-ecs-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Bedrock: All Claude models (Opus, Sonnet, Haiku)
    // Both foundation-model and inference-profile ARNs required
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        // Foundation model ARNs
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        // Global inference profile ARNs
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-*`,
        // APAC inference profile ARNs
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/apac.anthropic.claude-*`,
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

    // ECR Repository
    this.ecrRepo = new ecr.Repository(this, 'DevenvRepo', {
      repositoryName: 'cc-on-bedrock/devenv',
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // EFS File System
    const fileSystem = new efs.FileSystem(this, 'DevenvEfs', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      kmsKey: encryptionKey,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Bucket for user workspace data
    const userDataBucket = new s3.Bucket(this, 'UserDataBucket', {
      bucketName: `cc-on-bedrock-user-data-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      versioned: true,
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(30),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // DynamoDB Table for user volume tracking
    const userVolumesTable = new dynamodb.Table(this, 'UserVolumesTable', {
      tableName: 'cc-user-volumes',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lambda Function for EBS lifecycle
    const ebsLifecycleLambda = new lambda.Function(this, 'EbsLifecycleLambda', {
      functionName: 'cc-on-bedrock-ebs-lifecycle',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'ebs-lifecycle.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        VOLUMES_TABLE: userVolumesTable.tableName,
        REGION: cdk.Aws.REGION,
      },
    });
    userVolumesTable.grantReadWriteData(ebsLifecycleLambda);
    ebsLifecycleLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateVolume', 'ec2:DeleteVolume', 'ec2:AttachVolume', 'ec2:DetachVolume',
                'ec2:CreateSnapshot', 'ec2:DeleteSnapshot', 'ec2:DescribeVolumes', 'ec2:DescribeSnapshots',
                'ec2:CreateTags'],
      resources: ['*'],
    }));

    // DLP Security Groups
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

    // Allow EFS access from all DLP SGs
    [sgOpen, sgRestricted, sgLocked].forEach(sg => {
      fileSystem.connections.allowFrom(sg, ec2.Port.tcp(2049), 'Allow EFS from devenv');
    });

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'DevenvCluster', {
      vpc,
      clusterName: config.ecsClusterName,
      containerInsights: true,
    });

    // ECS Capacity Provider (m7g.4xlarge ASG with Launch Template)
    const ecsInstanceRole = new iam.Role(this, 'EcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    // Bedrock permissions for Claude Code in containers (uses Instance Role via IMDS)
    ecsInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
      ],
    }));

    const ecsLaunchTemplate = new ec2.LaunchTemplate(this, 'EcsCapacityLaunchTemplate', {
      instanceType: (() => {
        const [instanceClass, instanceSize] = config.ecsHostInstanceType.split('.');
        return ec2.InstanceType.of(
          instanceClass.toUpperCase() as unknown as ec2.InstanceClass,
          instanceSize.toUpperCase() as unknown as ec2.InstanceSize,
        );
      })(),
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
    // Add ECS cluster name to user data
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
      enableManagedTerminationProtection: true,
      targetCapacityPercent: 80,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);

    // Log Group
    const logGroup = new logs.LogGroup(this, 'DevenvLogGroup', {
      logGroupName: '/cc-on-bedrock/ecs/devenv',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Definition helper
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
            // Direct Bedrock access (LiteLLM proxy removed)
            AWS_DEFAULT_REGION: cdk.Aws.REGION,
            AWS_REGION: cdk.Aws.REGION,
            SECURITY_POLICY: 'open',  // Overridden at RunTask time
          },
          portMappings: [{ containerPort: 8080 }],
          linuxParameters: new ecs.LinuxParameters(this, `LinuxParams-${os}-${tier.name}`, {
            initProcessEnabled: true,  // Required for ECS Exec
          }),
        });

        // EFS Volume
        // NOTE: For user isolation, override rootDirectory at RunTask time
        // with /users/{subdomain} to prevent cross-user file access.
        // Or create per-user EFS Access Points for stronger isolation.
        taskDef.addVolume({
          name: 'efs-workspace',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/',  // Override per-user at RunTask: /users/{subdomain}
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

    // ALB for Dev Environment
    const albSg = new ec2.SecurityGroup(this, 'DevenvAlbSg', {
      vpc, description: 'DevEnv ALB SG', allowAllOutbound: true,
    });
    // CloudFront Prefix List - allow only CloudFront IPs
    albSg.addIngressRule(ec2.Peer.prefixList(config.cloudfrontPrefixListId), ec2.Port.tcp(443), 'Allow CloudFront HTTPS');
    albSg.addIngressRule(ec2.Peer.prefixList(config.cloudfrontPrefixListId), ec2.Port.tcp(80), 'Allow HTTP from CloudFront only');

    // Allow ALB → DevEnv containers on port 8080
    [sgOpen, sgRestricted, sgLocked].forEach(sg => {
      sg.addIngressRule(albSg, ec2.Port.tcp(8080), 'Allow from DevEnv ALB');
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'DevenvAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Listener - HTTPS if certificate provided, otherwise HTTP
    if (devEnvCertificateArn) {
      this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(devEnvCertificateArn)],
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Forbidden',
        }),
      });
    }
    // HTTP listener (CloudFront uses http-only origin)
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'DevenvCf', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(this.alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      // Note: CloudFront cert must be in us-east-1, handled separately
      comment: 'CC-on-Bedrock Dev Environment',
    });

    // Route 53 Wildcard Record
    new route53.ARecord(this, 'DevEnvWildcard', {
      zone: hostedZone,
      recordName: `*.${config.devSubdomain}`,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
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

    // Outputs
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName, exportName: 'cc-ecs-cluster-name' });
    new cdk.CfnOutput(this, 'EfsId', { value: fileSystem.fileSystemId, exportName: 'cc-efs-id' });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName, exportName: 'cc-devenv-cf-domain' });
    new cdk.CfnOutput(this, 'SgOpen', { value: sgOpen.securityGroupId, exportName: 'cc-sg-devenv-open' });
    new cdk.CfnOutput(this, 'SgRestricted', { value: sgRestricted.securityGroupId, exportName: 'cc-sg-devenv-restricted' });
    new cdk.CfnOutput(this, 'SgLocked', { value: sgLocked.securityGroupId, exportName: 'cc-sg-devenv-locked' });
    new cdk.CfnOutput(this, 'UserDataBucketName', { value: userDataBucket.bucketName });
    new cdk.CfnOutput(this, 'UserVolumesTableName', { value: userVolumesTable.tableName });
    new cdk.CfnOutput(this, 'EbsLifecycleLambdaArn', { value: ebsLifecycleLambda.functionArn });

    // NLB + Nginx routing outputs
    new cdk.CfnOutput(this, 'RoutingTableName', { value: routingTable.tableName, exportName: 'cc-routing-table-name' });
    new cdk.CfnOutput(this, 'NginxConfigLambdaArn', { value: nginxConfigLambda.functionArn });
  }
}
