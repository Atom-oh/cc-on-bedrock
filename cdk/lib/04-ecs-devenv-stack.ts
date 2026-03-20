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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface EcsDevenvStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  litellmAlbDns: string;
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
            litellmAlbDns, devEnvCertificateArn, hostedZone, cloudfrontSecret } = props;

    // ECS Task Role (created in this stack to avoid cross-stack cyclic references)
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: 'cc-on-bedrock-ecs-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
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
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

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
      clusterName: 'cc-on-bedrock-devenv',
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

    const ecsLaunchTemplate = new ec2.LaunchTemplate(this, 'EcsCapacityLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M7G, ec2.InstanceSize.XLARGE4),
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
      enableManagedTerminationProtection: false,
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
          // Use fromRegistry to avoid cross-stack grantPull cyclic reference
          // ECR pull permission is handled via AmazonECSTaskExecutionRolePolicy managed policy
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
            ANTHROPIC_BASE_URL: `http://${litellmAlbDns}:4000`,
            AWS_DEFAULT_REGION: 'ap-northeast-2',
            SECURITY_POLICY: 'open',  // Overridden at RunTask time
          },
          portMappings: [{ containerPort: 8080 }],
        });

        // EFS Volume
        taskDef.addVolume({
          name: 'efs-workspace',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
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
    // Note: pl-22a6434b is the CloudFront managed prefix list for ap-northeast-2
    albSg.addIngressRule(ec2.Peer.prefixList('pl-22a6434b'), ec2.Port.tcp(443), 'Allow CloudFront');

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
    } else {
      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Forbidden - ACM certificate not yet configured',
        }),
      });
    }

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'DevenvCf', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(this.alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-Custom-Secret': cloudfrontSecret.secretValue.unsafeUnwrap(),
          },
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

    // Outputs
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName, exportName: 'cc-ecs-cluster-name' });
    new cdk.CfnOutput(this, 'EfsId', { value: fileSystem.fileSystemId, exportName: 'cc-efs-id' });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName, exportName: 'cc-devenv-cf-domain' });
  }
}
