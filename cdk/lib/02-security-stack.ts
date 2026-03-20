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
  public readonly litellmMasterKeySecret: secretsmanager.Secret;

  public readonly cloudfrontSecret: secretsmanager.Secret;
  public readonly valkeyAuthSecret: secretsmanager.Secret;
  public readonly litellmEc2Role: iam.Role;
  public readonly dashboardEc2Role: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { config, hostedZone } = props;
    const devDomain = `*.${config.devSubdomain}.${config.domainName}`;
    const dashboardDomain = `dashboard.${config.domainName}`;

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
        requireSymbols: false,
      },
      customAttributes: {
        subdomain: new cognito.StringAttribute({ mutable: true }),
        container_os: new cognito.StringAttribute({ mutable: true }),
        resource_tier: new cognito.StringAttribute({ mutable: true }),
        security_policy: new cognito.StringAttribute({ mutable: true }),
        litellm_api_key: new cognito.StringAttribute({ mutable: true }),
        container_id: new cognito.StringAttribute({ mutable: true }),
      },
    });

    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://dashboard.${config.domainName}/api/auth/callback/cognito`],
        logoutUrls: [`https://dashboard.${config.domainName}`],
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
      resources: ['*'],
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
        'cognito-idp:ListUsers',
      ],
      resources: [this.userPool.userPoolArn],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:ListTasks'],
      resources: ['*'],
    }));
    this.dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      // ECS role ARNs use a pattern since roles are in another stack
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-task`,
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-ecs-task-execution`,
      ],
    }));

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, exportName: 'cc-user-pool-id' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, exportName: 'cc-user-pool-client-id' });
  }
}
