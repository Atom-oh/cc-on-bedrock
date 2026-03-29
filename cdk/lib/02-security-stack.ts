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
  // TODO: Remove litellmMasterKeySecret, valkeyAuthSecret, and litellmEc2Role
  // once the CcOnBedrock-LiteLLM CloudFormation stack is fully deleted.
  // These are retained to avoid breaking the existing deployed stack dependency.
  public readonly litellmMasterKeySecret: secretsmanager.Secret;

  public readonly cloudfrontSecret: secretsmanager.Secret;
  public readonly valkeyAuthSecret: secretsmanager.Secret;
  public readonly litellmEc2Role: iam.Role;
  public readonly dashboardEc2Role: iam.Role;
  public readonly taskPermissionBoundary: iam.ManagedPolicy;

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
      },
    });

    // Cognito Hosted UI domain for OAuth login
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    const dashboardUrl = `https://${dashboardDomain}`;
    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${dashboardUrl}/api/auth/callback/cognito`],
        logoutUrls: [dashboardUrl],
      },
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
    this.litellmMasterKeySecret = new secretsmanager.Secret(this, 'LitellmMasterKey', {
      secretName: 'cc-on-bedrock/litellm-master-key',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    // Note: RDS credentials are created in the LiteLLM stack to avoid cyclic cross-stack references

    this.cloudfrontSecret = new secretsmanager.Secret(this, 'CloudFrontSecret', {
      secretName: 'cc-on-bedrock/cloudfront-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    this.valkeyAuthSecret = new secretsmanager.Secret(this, 'ValkeyAuth', {
      secretName: 'cc-on-bedrock/valkey-auth',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    // IAM Roles
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
      ],
    });

    // LiteLLM EC2 Role
    this.litellmEc2Role = new iam.Role(this, 'LitellmEc2Role', {
      roleName: 'cc-on-bedrock-litellm-ec2',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });
    this.litellmEc2Role.addToPolicy(bedrockPolicy);
    // Broad secret access for all cc-on-bedrock secrets (avoids cross-stack cyclic references)
    this.litellmEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/*`],
    }));

    // Note: ECS Task and Execution roles are created in the EcsDevenv stack
    // to avoid cross-stack cyclic references with ECR/EFS/CloudWatch

    // Permission Boundary for per-user ECS Task Roles
    // Caps the maximum permissions any cc-on-bedrock-task-* role can have
    this.taskPermissionBoundary = new iam.ManagedPolicy(this, 'TaskPermissionBoundary', {
      managedPolicyName: 'cc-on-bedrock-task-boundary',
      statements: [
        new iam.PolicyStatement({
          sid: 'BedrockClaude',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
          resources: [
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
            `arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/*anthropic.claude-*`,
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
      ],
    });

    // Dashboard EC2 Role
    this.dashboardEc2Role = new iam.Role(this, 'DashboardEc2Role', {
      roleName: 'cc-on-bedrock-dashboard-ec2',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser', 'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:ListUsers',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [this.userPool.userPoolArn],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:TagResource'],
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
      ],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'IamTaskRoleManagement',
      actions: ['iam:CreateRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole', 'iam:DeleteRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
      conditions: {
        StringEquals: {
          'iam:PermissionsBoundary': this.taskPermissionBoundary.managedPolicyArn,
        },
      },
    }));
    // Allow GetRole without boundary condition (needed to check if role exists)
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'IamTaskRoleRead',
      actions: ['iam:GetRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
    }));
    // Secrets Manager: per-user code-server passwords
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerCodeserver',
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret', 'secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:cc-on-bedrock/codeserver/*`],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBAccess',
      actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:BatchGetItem'],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.projectPrefix}-usage`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.projectPrefix}-usage/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-department-budgets`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-department-budgets/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-on-bedrock-approval-requests`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-on-bedrock-approval-requests/*`,
      ],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'RoutingTableAccess',
      actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-routing-table`,
      ],
    }));
    this.encryptionKey.grantDecrypt(this.dashboardEc2Role);
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'EfsAccessPointManagement',
      actions: [
        'elasticfilesystem:CreateAccessPoint',
        'elasticfilesystem:DescribeAccessPoints',
        'elasticfilesystem:DeleteAccessPoint',
      ],
      resources: [`arn:aws:elasticfilesystem:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:file-system/*`],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsTaskDefRegistration',
      actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
      resources: ['*'],
    }));

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, exportName: 'cc-user-pool-id' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, exportName: 'cc-user-pool-client-id' });
  }
}
