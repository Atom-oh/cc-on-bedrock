import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

/**
 * EC2-per-user DevEnv Stack
 *
 * Each user gets their own EC2 instance with persistent EBS root volume.
 * Stop/Start preserves all state — files, packages, system config.
 * No EBS snapshot/restore, no Docker, no symlink hacks.
 *
 * Architecture:
 *   Dashboard API → RunInstances(AMI) or StartInstances
 *     → EC2 instance (t4g.large, ARM64)
 *     → code-server on port 8080
 *     → Nginx routing via cc-routing-table DynamoDB
 *     → SSM Session Manager only (no SSH)
 */
export interface Ec2DevenvStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  vpc: ec2.Vpc;
  encryptionKey: kms.Key;
  taskPermissionBoundary?: iam.IManagedPolicy;
}

export class Ec2DevenvStack extends cdk.Stack {
  public readonly sgOpen: ec2.SecurityGroup;
  public readonly sgRestricted: ec2.SecurityGroup;
  public readonly sgLocked: ec2.SecurityGroup;
  public readonly devenvRole: iam.Role;
  public readonly instanceProfile: iam.CfnInstanceProfile;
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly instanceTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: Ec2DevenvStackProps) {
    super(scope, id, props);

    const { config, vpc, encryptionKey } = props;

    // ─── DLP Security Groups (no SSH, SSM only) ───
    this.sgOpen = new ec2.SecurityGroup(this, 'DevenvSgOpen', {
      vpc,
      description: 'DevEnv Open: code-server + all outbound',
      allowAllOutbound: true,
    });
    this.sgOpen.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(8080),
      'code-server from VPC (via Nginx)',
    );

    this.sgRestricted = new ec2.SecurityGroup(this, 'DevenvSgRestricted', {
      vpc,
      description: 'DevEnv Restricted: code-server, limited outbound',
      allowAllOutbound: false,
    });
    this.sgRestricted.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(8080),
      'code-server from VPC',
    );
    // Restricted outbound: HTTPS only (for Bedrock, ECR, SSM)
    this.sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound');
    this.sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS');
    this.sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS UDP');

    this.sgLocked = new ec2.SecurityGroup(this, 'DevenvSgLocked', {
      vpc,
      description: 'DevEnv Locked: code-server only, no outbound except AWS',
      allowAllOutbound: false,
    });
    this.sgLocked.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(8080),
      'code-server from VPC',
    );
    // Locked: only VPC endpoints (HTTPS to VPC CIDR)
    this.sgLocked.addEgressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(443),
      'HTTPS to VPC endpoints only',
    );

    // ─── IAM Role (Bedrock + SSM + CloudWatch) ───
    this.devenvRole = new iam.Role(this, 'DevenvInstanceRole', {
      roleName: 'cc-on-bedrock-devenv-instance',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
      ...(props.taskPermissionBoundary ? { permissionsBoundary: props.taskPermissionBoundary } : {}),
    });

    // Bedrock access
    this.devenvRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse', 'bedrock:ConverseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-*`,
      ],
    }));

    // KMS decrypt (for encrypted EBS)
    encryptionKey.grantDecrypt(this.devenvRole);

    // Instance Profile
    this.instanceProfile = new iam.CfnInstanceProfile(this, 'DevenvInstanceProfile', {
      instanceProfileName: 'cc-on-bedrock-devenv-instance',
      roles: [this.devenvRole.roleName],
    });

    // ─── Launch Template ───
    // AMI ID is managed by build-ami.sh → SSM Parameter /cc-on-bedrock/devenv/ami-id
    // Dashboard API reads it at runtime for RunInstances
    this.launchTemplate = new ec2.LaunchTemplate(this, 'DevenvLaunchTemplate', {
      launchTemplateName: 'cc-on-bedrock-devenv',
      instanceType: new ec2.InstanceType(config.devenvInstanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      role: this.devenvRole,
      securityGroup: this.sgOpen,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(30, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: false,  // Preserve data on Stop
        }),
      }],
    });

    // ─── DynamoDB: User → Instance mapping ───
    this.instanceTable = new dynamodb.Table(this, 'UserInstancesTable', {
      tableName: 'cc-user-instances',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'LaunchTemplateId', {
      value: this.launchTemplate.launchTemplateId!,
    });
    new cdk.CfnOutput(this, 'InstanceProfileArn', {
      value: this.instanceProfile.attrArn,
    });
    new cdk.CfnOutput(this, 'InstanceTableName', {
      value: this.instanceTable.tableName,
    });
    new cdk.CfnOutput(this, 'SgOpen', { value: this.sgOpen.securityGroupId });
    new cdk.CfnOutput(this, 'SgRestricted', { value: this.sgRestricted.securityGroupId });
    new cdk.CfnOutput(this, 'SgLocked', { value: this.sgLocked.securityGroupId });
  }
}
