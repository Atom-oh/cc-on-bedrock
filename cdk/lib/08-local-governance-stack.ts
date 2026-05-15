import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';
import { CcOnBedrockConfig } from '../config/default';

export interface LocalGovernanceStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  encryptionKey: kms.Key;
  usageTable: dynamodb.Table;
  taskPermissionBoundary: iam.ManagedPolicy;
  // ADR-022: the provisioner Lambda calls AdminGetUser / AdminUpdateUserAttributes /
  // ListUsersInGroup. CloudTrail redacts username + custom attrs in events, so the
  // Lambda has to re-fetch via the userPool ARN granted here.
  userPool: cognito.UserPool;
}

/**
 * Local Governance Mode (ADR-014)
 *
 * Resources:
 *  - cc-on-bedrock-limits DynamoDB table (per-user / per-dept normalized-token state)
 *  - STS Issuer Lambda + Function URL (IAM auth) — Dashboard-invoked
 *  - Token Limit Enforcer Lambda — usage table Stream consumer
 *  - Limit Reset Lambda + 3 EventBridge crons (daily/weekly/monthly @ KST boundaries)
 *  - SNS alert topic (separate from EC2-mode budget alerts)
 */
export class LocalGovernanceStack extends cdk.Stack {
  public readonly limitsTable: dynamodb.Table;
  public readonly stsIssuerFunction: lambda.Function;
  public readonly stsIssuerFunctionUrl: lambda.FunctionUrl;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: LocalGovernanceStackProps) {
    super(scope, id, props);
    const { config, encryptionKey, usageTable, taskPermissionBoundary, userPool } = props;

    // ──────────────────────────────────────────────────────────
    // SNS alert topic
    // ──────────────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'LocalGovAlerts', {
      topicName: 'cc-on-bedrock-local-gov-alerts',
      displayName: 'CC-on-Bedrock Local Governance Alerts',
      masterKey: encryptionKey,
    });

    // ──────────────────────────────────────────────────────────
    // Limits table — keyed by USER#{sub} / DEPT#{dept} × LIMIT|COUNTER|DENY|WARN
    // ──────────────────────────────────────────────────────────
    this.limitsTable = new dynamodb.Table(this, 'LimitsTable', {
      tableName: 'cc-on-bedrock-limits',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // ──────────────────────────────────────────────────────────
    // STS Issuer Lambda
    // ADR-021: per-model IAM restriction removed. The Lambda issues credentials with
    // a wildcard Claude-family inline policy; model-level gating is handled at runtime
    // by token-limit-enforcer (ADR-014) + budget-check (ADR-015).
    // ──────────────────────────────────────────────────────────
    this.stsIssuerFunction = new lambda.Function(this, 'StsIssuer', {
      functionName: 'cc-on-bedrock-sts-issuer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'sts-issuer.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      // ADR-022: retry budget bumped to 6 attempts (31s of sleeps) for the
      // pre-provisioner-miss fallback path. Lambda timeout must accommodate
      // the worst-case AssumeRole + 31s backoff + ensure_role + DDB lookups.
      timeout: cdk.Duration.seconds(45),
      memorySize: 256,
      environment: {
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        LIMITS_TABLE: this.limitsTable.tableName,
        PERMISSION_BOUNDARY_NAME: 'cc-on-bedrock-task-boundary',
        ASSUMER_ROLE_ARN: '', // populated after role create via override below
        // AWS role chaining hard-caps the AssumeRole session at 1h regardless of
        // MaxSessionDuration on the target role. The STS Issuer Lambda *is* a role
        // assuming another role, so 28800s (8h) is rejected with ValidationError.
        // We issue 3600s (1h) creds; the CLI helper auto-refreshes when remaining < 10min.
        SESSION_DURATION_SECONDS: '3600',  // 1h (role-chaining hard cap)
        MAX_SESSION_DURATION_SECONDS: '3600',
        INFERENCE_PROFILE_PREFIX: config.projectPrefix,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Inject assumer role ARN once Lambda role is created (cycle break)
    this.stsIssuerFunction.addEnvironment('ASSUMER_ROLE_ARN', this.stsIssuerFunction.role!.roleArn);

    // IAM permissions: manage per-user roles + AssumeRole into them
    this.stsIssuerFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamPerUserRoleMgmt',
      actions: [
        'iam:CreateRole', 'iam:GetRole', 'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
        'iam:TagRole', 'iam:UntagRole', 'iam:ListRoleTags',
      ],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
    }));
    this.stsIssuerFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamPermissionBoundaryRead',
      actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
      resources: [taskPermissionBoundary.managedPolicyArn],
    }));
    this.stsIssuerFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'StsAssumeRoleIntoLocalUser',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
    }));
    this.limitsTable.grantReadData(this.stsIssuerFunction);

    // Function URL with IAM auth — Dashboard is the only authorized caller
    this.stsIssuerFunctionUrl = this.stsIssuerFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    new cdk.CfnOutput(this, 'StsIssuerFunctionUrl', {
      value: this.stsIssuerFunctionUrl.url,
      description: 'STS Issuer Function URL (IAM auth)',
      exportName: 'cc-on-bedrock-sts-issuer-url',
    });
    new cdk.CfnOutput(this, 'StsIssuerFunctionArn', {
      value: this.stsIssuerFunction.functionArn,
      exportName: 'cc-on-bedrock-sts-issuer-arn',
    });

    // ──────────────────────────────────────────────────────────
    // User Role Provisioner Lambda (ADR-022)
    // Pre-creates Local Governance role + EC2 task role/profile + canonical
    // custom:subdomain + custom:dept_manager_sub on each Cognito user event so
    // every entry point (seed script, dashboard, console, SDK) converges on
    // the same downstream state — removes the IAM-propagation race at first use.
    // ──────────────────────────────────────────────────────────
    // DLQ for events the provisioner can't process (subdomain collision, repeated
    // 5xx, IAM throttling spike). EventBridge default retry is 24h / 185 tries
    // and then drops silently — unacceptable for an identity provisioner.
    const provisionerDlq = new sqs.Queue(this, 'UserRoleProvisionerDlq', {
      queueName: 'cc-on-bedrock-user-role-provisioner-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: encryptionKey,
    });
    // EventBridge needs kms:GenerateDataKey on the customer KMS key to encrypt
    // DLQ payloads it writes after a failed target delivery. CDK auto-grants
    // SendMessage on the queue (queue policy) but skips the KMS side, so DLQ
    // writes silently fail with KMSAccessDenied.
    //
    // Scope: only GenerateDataKey + Decrypt (DLQ-writing minimum), and only
    // when the call is delegated through SQS in this region (`kms:ViaService`).
    // This prevents EventBridge rules elsewhere in the account from using the
    // shared CMK for unrelated operations.
    encryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'EventBridgeDlqEncrypt',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `sqs.${cdk.Aws.REGION}.amazonaws.com`,
        },
      },
    }));

    const provisioner = new lambda.Function(this, 'UserRoleProvisioner', {
      functionName: 'cc-on-bedrock-user-role-provisioner',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'user-role-provisioner.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      deadLetterQueue: provisionerDlq,
      deadLetterQueueEnabled: true,
      environment: {
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        PERMISSION_BOUNDARY_NAME: 'cc-on-bedrock-task-boundary',
        // Trust principal of the per-user Local Gov role is the STS Issuer Lambda role
        // (only Lambda that AssumeRoles into it). Same value sts-issuer.py uses.
        ASSUMER_ROLE_ARN: this.stsIssuerFunction.role!.roleArn,
        MAX_SESSION_DURATION_SECONDS: '3600',
        // CloudTrail redacts user attributes — Lambda re-fetches via AdminGetUser.
        USER_POOL_ID: userPool.userPoolId,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Per-user IAM (Local Gov)
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamLocalUserRoleMgmt',
      actions: [
        'iam:CreateRole', 'iam:GetRole', 'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:ListRoleTags',
      ],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
    }));
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamPermissionBoundaryRead',
      actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
      resources: [taskPermissionBoundary.managedPolicyArn],
    }));
    // Per-user IAM (EC2 task) + instance profile. PassRole is required because
    // AddRoleToInstanceProfile treats it as passing the role into ec2.amazonaws.com.
    // Split into two statements so we can scope PassRole with a service condition.
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamEc2TaskRoleMgmt',
      actions: [
        'iam:CreateRole', 'iam:GetRole', 'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:ListRoleTags',
        'iam:CreateInstanceProfile', 'iam:GetInstanceProfile',
        'iam:AddRoleToInstanceProfile',
      ],
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`,
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/cc-on-bedrock-task-*`,
      ],
    }));
    // PassRole scoped to ec2.amazonaws.com so the provisioner cannot pass these
    // task roles to other service principals (least-privilege).
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamPassRoleToEc2',
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' },
      },
    }));
    // Cognito reads (recover redacted attrs) + writes (set canonical
    // custom:subdomain + custom:dept_manager_sub).
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CognitoUserReadWrite',
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers',
        'cognito-idp:ListUsersInGroup',
        'cognito-idp:AdminUpdateUserAttributes',
      ],
      resources: [userPool.userPoolArn],
    }));

    // Single EventBridge rule for all relevant Cognito-IDP events.
    // We previously tried to filter group-membership events on
    // requestParameters.groupName=dept-manager at the EventBridge layer to
    // suppress noise invocations, but some account configurations mask the
    // ENTIRE requestParameters object as HIDDEN_DUE_TO_SECURITY_REASONS —
    // which would cause the rule to never match and silently drop manager
    // promotions. Filtering for the dept-manager group happens inside the
    // Lambda handler instead (handler returns skipped:group_not_dept_manager).
    new events.Rule(this, 'CognitoUserCreatedRule', {
      ruleName: 'cc-on-bedrock-cognito-user-created',
      description: 'Trigger UserRoleProvisioner on AdminCreateUser / SignUp / AdminAddUserToGroup / AdminRemoveUserFromGroup (ADR-022)',
      eventPattern: {
        source: ['aws.cognito-idp'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['cognito-idp.amazonaws.com'],
          eventName: ['AdminCreateUser', 'SignUp', 'AdminAddUserToGroup', 'AdminRemoveUserFromGroup'],
        },
      },
      targets: [new targets.LambdaFunction(provisioner, {
        deadLetterQueue: provisionerDlq,
      })],
    });

    new cdk.CfnOutput(this, 'UserRoleProvisionerArn', {
      value: provisioner.functionArn,
      description: 'User Role Provisioner Lambda ARN (ADR-022)',
      exportName: 'cc-on-bedrock-user-role-provisioner-arn',
    });

    // ──────────────────────────────────────────────────────────
    // Token Limit Enforcer Lambda (usage table Stream consumer)
    // ──────────────────────────────────────────────────────────
    const enforcer = new lambda.Function(this, 'TokenLimitEnforcer', {
      functionName: 'cc-on-bedrock-token-limit-enforcer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'token-limit-enforcer.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        LIMITS_TABLE: this.limitsTable.tableName,
        SNS_TOPIC_ARN: this.alertTopic.topicArn,
        DENY_POLICY_NAME: 'cc-bedrock-local-token-deny',
        WARNING_THRESHOLDS: '0.8,0.95',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.limitsTable.grantReadWriteData(enforcer);
    this.alertTopic.grantPublish(enforcer);
    enforcer.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamDenyAttach',
      actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
    }));

    // Subscribe to usage table Stream (consumes USER# row updates)
    enforcer.addEventSource(new lambdaEventSources.DynamoEventSource(usageTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 3,
      reportBatchItemFailures: true,
      bisectBatchOnError: true,
    }));

    // ──────────────────────────────────────────────────────────
    // Limit Reset Lambda + EventBridge crons (KST aware)
    // ──────────────────────────────────────────────────────────
    const reset = new lambda.Function(this, 'LimitReset', {
      functionName: 'cc-on-bedrock-limit-reset',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'limit-reset.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        LIMITS_TABLE: this.limitsTable.tableName,
        DENY_POLICY_NAME: 'cc-bedrock-local-token-deny',
        SNS_TOPIC_ARN: this.alertTopic.topicArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.limitsTable.grantReadWriteData(reset);
    this.alertTopic.grantPublish(reset);
    reset.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamDenyDetach',
      actions: ['iam:DeleteRolePolicy', 'iam:GetRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-local-user-*`],
    }));

    // KST 00:00 = UTC 15:00 (KST = UTC+9)
    // daily: every day at 15:00 UTC == next-day 00:00 KST
    new events.Rule(this, 'DailyResetRule', {
      ruleName: 'cc-on-bedrock-limit-reset-daily',
      schedule: events.Schedule.cron({ minute: '0', hour: '15', day: '*', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(reset, {
        event: events.RuleTargetInput.fromObject({ period: 'daily' }),
      })],
    });

    // weekly: every Sunday 15:00 UTC == Monday 00:00 KST
    new events.Rule(this, 'WeeklyResetRule', {
      ruleName: 'cc-on-bedrock-limit-reset-weekly',
      schedule: events.Schedule.cron({ minute: '0', hour: '15', weekDay: 'SUN', year: '*' }),
      targets: [new targets.LambdaFunction(reset, {
        event: events.RuleTargetInput.fromObject({ period: 'weekly' }),
      })],
    });

    // monthly: last day of month 15:00 UTC == 1st 00:00 KST
    new events.Rule(this, 'MonthlyResetRule', {
      ruleName: 'cc-on-bedrock-limit-reset-monthly',
      schedule: events.Schedule.cron({ minute: '0', hour: '15', day: 'L', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(reset, {
        event: events.RuleTargetInput.fromObject({ period: 'monthly' }),
      })],
    });

    // ──────────────────────────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'LimitsTableName', {
      value: this.limitsTable.tableName,
      exportName: 'cc-on-bedrock-limits-table',
    });
    new cdk.CfnOutput(this, 'LocalGovAlertTopicArn', {
      value: this.alertTopic.topicArn,
      exportName: 'cc-on-bedrock-local-gov-alerts',
    });
  }
}
