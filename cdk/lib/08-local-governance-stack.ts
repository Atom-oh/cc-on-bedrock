import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';
import { CcOnBedrockConfig } from '../config/default';

export interface LocalGovernanceStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  encryptionKey: kms.Key;
  usageTable: dynamodb.Table;
  taskPermissionBoundary: iam.ManagedPolicy;
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
    const { config, encryptionKey, usageTable, taskPermissionBoundary } = props;

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
      timeout: cdk.Duration.seconds(20),
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
