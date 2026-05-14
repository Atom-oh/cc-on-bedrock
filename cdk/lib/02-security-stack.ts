import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface SecurityStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  hostedZone: route53.IHostedZone;
}

export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly encryptionKey: kms.Key;
  public readonly cloudfrontSecret: secretsmanager.Secret;
  public readonly dashboardEc2Role: iam.Role;
  public readonly taskPermissionBoundary: iam.ManagedPolicy;
  public readonly ecsInfrastructureRole: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { config, hostedZone } = props;
    const devDomain = `*.${config.devSubdomain}.${config.domainName}`;
    const dashboardDomain = `${config.dashboardSubdomain}.${config.domainName}`;

    // KMS Encryption Key
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      alias: 'cc-on-bedrock',
      enableKeyRotation: true,
      description: 'CC-on-Bedrock encryption key for EBS, RDS, EFS',
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'cc-on-bedrock-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      customAttributes: {
        subdomain: new cognito.StringAttribute({ mutable: true }),
        container_os: new cognito.StringAttribute({ mutable: true }),
        resource_tier: new cognito.StringAttribute({ mutable: true }),
        security_policy: new cognito.StringAttribute({ mutable: true }),
        container_id: new cognito.StringAttribute({ mutable: true }),
        department: new cognito.StringAttribute({ mutable: true }),
        budget_exceeded: new cognito.StringAttribute({ mutable: true }),
        storage_type: new cognito.StringAttribute({ mutable: true }),
        // ADR-022: sub of this user's department manager. Populated by the
        // user-role-provisioner Lambda on AdminCreateUser / AdminAddUserToGroup.
        // Self-pointing for the manager themselves; empty for admin (no dept).
        dept_manager_sub: new cognito.StringAttribute({ mutable: true }),
      },
    });

    // Cognito Hosted UI domain for OAuth login
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    const dashboardUrl = `https://${dashboardDomain}`;
    this.userPoolClient = this.userPool.addClient('AppClient', {
      generateSecret: true,
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${dashboardUrl}/api/auth/callback/cognito`],
        logoutUrls: [dashboardUrl],
      },
    });

    // ADR-014: Public app client for the cc-bedrock-local CLI (USER_PASSWORD_AUTH).
    // No secret so the CLI can authenticate from end-user machines without embedding
    // shared credentials. Access tokens from this client are verified by the
    // Dashboard's /api/local/credentials route via cognito-idp:GetUser.
    const cliPublicClient = this.userPool.addClient('CliPublicClient', {
      userPoolClientName: 'cc-on-bedrock-cli-public',
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      preventUserExistenceErrors: true,
    });
    new cdk.CfnOutput(this, 'CliPublicClientId', {
      value: cliPublicClient.userPoolClientId,
      description: 'Cognito app client id for cc-bedrock-local CLI (no secret)',
      exportName: 'cc-cli-public-client-id',
    });

    // Cognito Groups
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Dashboard administrators',
    });
    new cognito.CfnUserPoolGroup(this, 'UserGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'user',
      description: 'Dev environment users',
    });
    new cognito.CfnUserPoolGroup(this, 'DeptManagerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'dept-manager',
      description: 'Department managers who can approve users and manage department budgets',
      precedence: 5,
    });

    // ACM Certificates are created separately after DNS is configured.
    // Once validated, pass certificate ARNs via CDK context:
    //   cdk deploy -c devEnvCertArn=arn:aws:acm:... -c dashboardCertArn=arn:aws:acm:...

    // Secrets Manager
    this.cloudfrontSecret = new secretsmanager.Secret(this, 'CloudFrontSecret', {
      secretName: 'cc-on-bedrock/cloudfront-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    // IAM Roles
    // ADR-021: Bedrock IAM uses wildcard Claude family (region-prefix agnostic).
    // Pattern covers `anthropic.claude-*`, `global.anthropic.claude-*`, `us.anthropic.claude-*`,
    // `apac.anthropic.claude-*`, `eu.anthropic.claude-*`, and future region prefixes.
    // Per-model spend control is delegated to token-limit-enforcer (ADR-014) + budget-check (ADR-015).
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
      ],
    });

    // Note: ECS Task and Execution roles are created in the EcsDevenv stack
    // to avoid cross-stack cyclic references with ECR/EFS/CloudWatch

    // Permission Boundary for per-user ECS Task Roles
    // Caps the maximum permissions any cc-on-bedrock-task-* role can have
    this.taskPermissionBoundary = new iam.ManagedPolicy(this, 'TaskPermissionBoundary', {
      managedPolicyName: 'cc-on-bedrock-task-boundary',
      statements: [
        // ADR-021: wildcard Claude family in Permission Boundary too — boundary must be
        // at least as permissive as any role's inline policy, else effective permission = ∅.
        // Per-model usage gating is handled at runtime by token-limit-enforcer (ADR-014).
        new iam.PolicyStatement({
          sid: 'BedrockClaude',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
          resources: [
            'arn:aws:bedrock:*::foundation-model/*anthropic.claude-*',
            `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
            `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'S3Access',
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::cc-on-bedrock-user-data-${cdk.Aws.ACCOUNT_ID}`,
            `arn:aws:s3:::cc-on-bedrock-user-data-${cdk.Aws.ACCOUNT_ID}/*`,
            `arn:aws:s3:::${config.projectPrefix}-deploy-${cdk.Aws.ACCOUNT_ID}`,
            `arn:aws:s3:::${config.projectPrefix}-deploy-${cdk.Aws.ACCOUNT_ID}/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'KmsDecrypt',
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
          resources: [this.encryptionKey.keyArn],
        }),
        new iam.PolicyStatement({
          sid: 'CloudWatchMetrics',
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'CloudWatchLogs',
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
          resources: [`arn:aws:logs:*:${cdk.Aws.ACCOUNT_ID}:log-group:/cc-on-bedrock/*`],
        }),
        new iam.PolicyStatement({
          sid: 'EcrAuth',
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'EcrPull',
          actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
          resources: [`arn:aws:ecr:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:repository/cc-on-bedrock/*`],
        }),
        new iam.PolicyStatement({
          sid: 'SsmMessages',
          actions: ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'SecretsRead',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:*:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/*`],
        }),
        new iam.PolicyStatement({
          sid: 'AgentCoreGateway',
          actions: ['bedrock-agentcore:InvokeGateway'],
          resources: [`arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:gateway/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DynamoDbMcpConfig',
          actions: ['dynamodb:GetItem', 'dynamodb:Query'],
          resources: [
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-dept-mcp-config`,
          ],
        }),
      ],
    });

    // ECS Infrastructure Role — required for EBS volume attachment to tasks
    this.ecsInfrastructureRole = new iam.Role(this, 'EcsInfrastructureRole', {
      roleName: 'cc-on-bedrock-ecs-infrastructure',
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSInfrastructureRolePolicyForVolumes'),
      ],
    });
    // Grant KMS access for encrypted EBS volume creation
    this.encryptionKey.grantEncryptDecrypt(this.ecsInfrastructureRole);
    // ECS needs CreateGrant to delegate KMS access to EC2 for EBS attach
    this.ecsInfrastructureRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KmsCreateGrantForEbs',
      actions: ['kms:CreateGrant', 'kms:DescribeKey'],
      resources: [this.encryptionKey.keyArn],
      conditions: {
        Bool: { 'kms:GrantIsForAWSResource': 'true' },
      },
    }));

    // Dashboard Role (shared by ECS Task + Troubleshooting EC2 instance profile)
    this.dashboardEc2Role = new iam.Role(this, 'DashboardEc2Role', {
      roleName: 'cc-on-bedrock-dashboard-ec2',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('ec2.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    this.dashboardEc2Role.addToPolicy(bedrockPolicy);
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser', 'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminSetUserPassword',
        'cognito-idp:ListUsers',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [this.userPool.userPoolArn],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:TagResource', 'ecs:ExecuteCommand'],
      resources: [
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/${config.ecsClusterName}`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/${config.ecsClusterName}/*`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/devenv-*`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:container-instance/${config.ecsClusterName}/*`,
      ],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'EfsAccess',
      actions: ['elasticfilesystem:DescribeFileSystems'],
      resources: [`arn:aws:elasticfilesystem:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:file-system/*`],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'AlbManagement',
      actions: [
        'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:DescribeRules',
      ],
      resources: [`arn:aws:elasticloadbalancing:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-task`,
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-task-execution`,
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`,
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-infrastructure`,
      ],
    }));
    // Data & infra management — separate managed policy to avoid 10KB inline limit
    const dataInfraPolicy = new iam.ManagedPolicy(this, 'DashboardDataInfraPolicy', {
      managedPolicyName: 'cc-on-bedrock-dashboard-data-infra',
      roles: [this.dashboardEc2Role],
      statements: [
        new iam.PolicyStatement({
          sid: 'IamTaskRoleManagement',
          actions: ['iam:CreateRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole', 'iam:DeleteRole'],
          resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
        }),
        new iam.PolicyStatement({
          sid: 'SecretsManagerCodeserver',
          actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret', 'secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/codeserver/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DynamoDBAccess',
          actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchGetItem'],
          resources: [
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.projectPrefix}-usage`,
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.projectPrefix}-usage/*`,
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-department-budgets`,
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-on-bedrock-approval-requests`,
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-budgets`,
            // ADR-014: Local Governance limits table (CRUD on LIMIT/DENY items, read counters)
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.projectPrefix}-limits`,
          ],
        }),
        // ADR-014: admin reset endpoint detaches Deny policy from local-user roles
        new iam.PolicyStatement({
          sid: 'IamLocalUserRoleReset',
          actions: ['iam:DeleteRolePolicy', 'iam:GetRolePolicy'],
          resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
        }),
        new iam.PolicyStatement({
          sid: 'RoutingTableAccess',
          actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
          resources: [`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-routing-table`],
        }),
        new iam.PolicyStatement({
          sid: 'EcsTaskDefRegistration',
          actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition', 'ecs:DescribeClusters'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'LambdaInvoke',
          actions: ['lambda:InvokeFunction'],
          resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:cc-on-bedrock-*`],
        }),
      ],
    });
    this.encryptionKey.grantDecrypt(this.dashboardEc2Role);

    // EC2-per-user DevEnv management — separate managed policy to avoid 10KB inline limit
    const ec2DevenvPolicy = new iam.ManagedPolicy(this, 'DashboardEc2DevenvPolicy', {
      managedPolicyName: 'cc-on-bedrock-dashboard-ec2-devenv',
      roles: [this.dashboardEc2Role],
      statements: [
        new iam.PolicyStatement({
          sid: 'Ec2DevenvInstances',
          actions: [
            'ec2:RunInstances', 'ec2:StartInstances', 'ec2:StopInstances',
            'ec2:TerminateInstances', 'ec2:DescribeInstances', 'ec2:CreateTags',
            'ec2:ModifyInstanceAttribute', 'ec2:ModifyNetworkInterfaceAttribute',
            'ec2:ModifyVolume', 'ec2:DescribeVolumes',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'Ec2DevenvDynamoDB',
          actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
          resources: [`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-instances`],
        }),
        new iam.PolicyStatement({
          sid: 'Ec2DevenvIamRoles',
          actions: ['iam:CreateRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:TagRole', 'iam:DeleteRole', 'iam:DeleteRolePolicy'],
          resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
        }),
        new iam.PolicyStatement({
          sid: 'Ec2DevenvInstanceProfiles',
          actions: ['iam:CreateInstanceProfile', 'iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile'],
          resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/cc-on-bedrock-task-*`],
        }),
        new iam.PolicyStatement({
          sid: 'Ec2DevenvPassRole',
          actions: ['iam:PassRole'],
          resources: [
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`,
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-devenv-instance`,
          ],
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, exportName: 'cc-user-pool-id' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, exportName: 'cc-user-pool-client-id' });
  }
}
