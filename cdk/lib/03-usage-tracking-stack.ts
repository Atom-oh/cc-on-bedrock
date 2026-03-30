import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDest from 'aws-cdk-lib/aws-logs-destinations';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CcOnBedrockConfig, isEbsMode } from '../config/default';
import * as path from 'path';

export interface UsageTrackingStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
  encryptionKey: kms.Key;
  userPool: cognito.UserPool;
}

export class UsageTrackingStack extends cdk.Stack {
  public readonly usageTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: UsageTrackingStackProps) {
    super(scope, id, props);

    const { config, encryptionKey, userPool } = props;

    // SNS Topic for budget alerts
    const alertTopic = new sns.Topic(this, 'BudgetAlertTopic', {
      topicName: 'cc-on-bedrock-budget-alerts',
      displayName: 'CC-on-Bedrock Budget Alerts',
    });

    // DynamoDB Table for usage tracking
    this.usageTable = new dynamodb.Table(this, 'UsageTable', {
      tableName: 'cc-on-bedrock-usage',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for department-level queries
    this.usageTable.addGlobalSecondaryIndex({
      indexName: 'dept-date-index',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Lambda for processing CloudTrail events
    const trackerLambda = new lambda.Function(this, 'BedrockUsageTracker', {
      functionName: 'cc-on-bedrock-usage-tracker',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'bedrock-usage-tracker.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        USAGE_TABLE_NAME: this.usageTable.tableName,
        ECS_CLUSTER_NAME: config.ecsClusterName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant Lambda permissions
    this.usageTable.grantReadWriteData(trackerLambda);
    trackerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'],
    }));

    // EventBridge Rule: Bedrock API calls from CloudTrail
    const bedrockRule = new events.Rule(this, 'BedrockApiRule', {
      ruleName: 'cc-on-bedrock-usage-tracking',
      description: 'Track Bedrock InvokeModel/Converse API calls for usage analytics',
      eventPattern: {
        source: ['aws.bedrock'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['bedrock.amazonaws.com'],
          eventName: [
            'InvokeModel',
            'InvokeModelWithResponseStream',
            'Converse',
            'ConverseStream',
          ],
        },
      },
    });
    bedrockRule.addTarget(new targets.LambdaFunction(trackerLambda));

    // Budget check Lambda (runs every 5 minutes)
    const budgetCheckLambda = new lambda.Function(this, 'BudgetCheckLambda', {
      functionName: 'cc-on-bedrock-budget-check',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'budget-check.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        USAGE_TABLE_NAME: this.usageTable.tableName,
        DEPT_BUDGETS_TABLE: 'cc-department-budgets',
        ECS_CLUSTER_NAME: config.ecsClusterName,
        DAILY_BUDGET_USD: String(config.dailyBudgetUsd),
        SNS_TOPIC_ARN: alertTopic.topicArn,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.usageTable.grantReadData(budgetCheckLambda);
    // Note: departmentBudgetsTable.grantReadData is called after table creation below
    // ECS: find and stop over-budget user containers
    budgetCheckLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask'],
      resources: ['*'],
    }));
    // Cognito: set budget_exceeded flag (specific user pool, not wildcard)
    budgetCheckLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminUpdateUserAttributes'],
      resources: [userPool.userPoolArn],
    }));
    // IAM: Attach/Remove Deny Policy on per-user Task Roles
    budgetCheckLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-task-*`],
    }));
    // SNS: send budget alerts
    alertTopic.grantPublish(budgetCheckLambda);

    // Schedule: every 5 minutes
    new events.Rule(this, 'BudgetCheckSchedule', {
      ruleName: 'cc-on-bedrock-budget-check-schedule',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(budgetCheckLambda)],
    });

    // DynamoDB Table for department budgets
    const departmentBudgetsTable = new dynamodb.Table(this, 'DepartmentBudgetsTable', {
      tableName: 'cc-department-budgets',
      partitionKey: { name: 'dept_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // DynamoDB Table for per-user budgets
    const userBudgetsTable = new dynamodb.Table(this, 'UserBudgetsTable', {
      tableName: 'cc-user-budgets',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Grant budget check Lambda read access to department budgets table
    departmentBudgetsTable.grantReadData(budgetCheckLambda);

    // ==================== Warm Stop Automation (EBS mode only) ====================
    const isEbs = isEbsMode(config);

    if (isEbs) {

    // DynamoDB Table for user volumes (used by warm-stop and EBS lifecycle)
    const userVolumesTable = new dynamodb.Table(this, 'UserVolumesTable', {
      tableName: 'cc-user-volumes',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Warm Stop Lambda
    const warmStopLambda = new lambda.Function(this, 'WarmStopLambda', {
      functionName: 'cc-on-bedrock-warm-stop',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'warm-stop.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        REGION: cdk.Aws.REGION,
        ECS_CLUSTER: 'cc-on-bedrock-devenv',
        VOLUMES_TABLE: userVolumesTable.tableName,
        IDLE_THRESHOLD_MINUTES: '30',
        SNS_TOPIC_ARN: alertTopic.topicArn,
        EBS_LIFECYCLE_LAMBDA: 'cc-on-bedrock-ebs-lifecycle',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant warm-stop Lambda permissions
    userVolumesTable.grantReadWriteData(warmStopLambda);
    alertTopic.grantPublish(warmStopLambda);

    // ECS permissions: list, describe, stop tasks
    warmStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:ListTasks',
        'ecs:DescribeTasks',
        'ecs:StopTask',
      ],
      resources: ['*'],
    }));

    // CloudWatch permissions: read metrics
    warmStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:GetMetricData',
      ],
      resources: ['*'],
    }));

    // Lambda invoke: call EBS lifecycle Lambda and self-invoke for async warm-stop
    warmStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:cc-on-bedrock-*`,
      ],
    }));

    // Idle Check Lambda (lightweight metrics checker, can be called independently)
    const idleCheckLambda = new lambda.Function(this, 'IdleCheckLambda', {
      functionName: 'cc-on-bedrock-idle-check',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'idle-check.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      environment: {
        REGION: cdk.Aws.REGION,
        ECS_CLUSTER: 'cc-on-bedrock-devenv',
        IDLE_CPU_THRESHOLD: '5.0',
        IDLE_NETWORK_THRESHOLD: '1000',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Idle check Lambda permissions
    idleCheckLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'],
    }));
    idleCheckLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData'],
      resources: ['*'],
    }));

    // EventBridge: Idle check every 5 minutes (triggers warm-stop check_idle action)
    const idleCheckRule = new events.Rule(this, 'IdleCheckRule', {
      ruleName: 'cc-idle-check',
      description: 'Check for idle ECS tasks every 5 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    idleCheckRule.addTarget(new targets.LambdaFunction(warmStopLambda, {
      event: events.RuleTargetInput.fromObject({ action: 'check_idle' }),
    }));

    // EventBridge: EOD batch shutdown (18:00 KST = 09:00 UTC)
    const eodShutdownRule = new events.Rule(this, 'EodShutdownRule', {
      ruleName: 'cc-eod-shutdown',
      schedule: events.Schedule.cron({ hour: '9', minute: '0' }),
    });
    eodShutdownRule.addTarget(new targets.LambdaFunction(warmStopLambda, {
      event: events.RuleTargetInput.fromObject({ action: 'schedule_shutdown' }),
    }));

    // EBS-mode CfnOutputs
    new cdk.CfnOutput(this, 'UserVolumesTableName', {
      value: userVolumesTable.tableName,
      exportName: 'cc-user-volumes-table-name',
    });
    new cdk.CfnOutput(this, 'WarmStopLambdaArn', {
      value: warmStopLambda.functionArn,
      exportName: 'cc-warm-stop-lambda-arn',
    });
    new cdk.CfnOutput(this, 'IdleCheckLambdaArn', {
      value: idleCheckLambda.functionArn,
      exportName: 'cc-idle-check-lambda-arn',
    });

    } // end if (isEbs)

    // Audit Logger Lambda
    const auditLoggerLambda = new lambda.Function(this, 'AuditLoggerLambda', {
      functionName: 'cc-on-bedrock-audit-logger',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'audit-logger.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        REGION: cdk.Aws.REGION,
        AUDIT_TABLE: 'cc-prompt-audit',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Audit DynamoDB Table
    const auditTable = new dynamodb.Table(this, 'PromptAuditTable', {
      tableName: 'cc-prompt-audit',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    auditTable.grantWriteData(auditLoggerLambda);

    // EventBridge rule for Bedrock invocations (from CloudTrail)
    const bedrockAuditRule = new events.Rule(this, 'BedrockAuditRule', {
      ruleName: 'cc-bedrock-audit',
      eventPattern: {
        source: ['aws.bedrock'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventName: ['InvokeModel', 'InvokeModelWithResponseStream', 'Converse', 'ConverseStream'],
        },
      },
    });
    bedrockAuditRule.addTarget(new targets.LambdaFunction(auditLoggerLambda));

    // Outputs
    new cdk.CfnOutput(this, 'UsageTableName', {
      value: this.usageTable.tableName,
      exportName: 'cc-usage-table-name',
    });
    new cdk.CfnOutput(this, 'UsageTableArn', {
      value: this.usageTable.tableArn,
      exportName: 'cc-usage-table-arn',
    });
    new cdk.CfnOutput(this, 'DepartmentBudgetsTableName', {
      value: departmentBudgetsTable.tableName,
      exportName: 'cc-department-budgets-table-name',
    });
    new cdk.CfnOutput(this, 'UserBudgetsTableName', {
      value: userBudgetsTable.tableName,
      exportName: 'cc-user-budgets-table-name',
    });
    new cdk.CfnOutput(this, 'AuditLoggerLambdaArn', { value: auditLoggerLambda.functionArn });
    new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });

    // ─── Bedrock Invocation Logging (token tracking) ───
    const bedrockLoggingRole = iam.Role.fromRoleName(this, 'BedrockLoggingRole', 'cc-on-bedrock-invocation-logging');

    const bedrockLogGroup = logs.LogGroup.fromLogGroupName(this, 'BedrockInvocationLogs', '/aws/bedrock/invocation-logs');

    // Enable Bedrock Invocation Logging via AwsCustomResource
    new cr.AwsCustomResource(this, 'EnableBedrockLogging', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: bedrockLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
      },
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: bedrockLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
      },
      onDelete: {
        service: 'Bedrock',
        action: 'deleteModelInvocationLoggingConfiguration',
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock:PutModelInvocationLoggingConfiguration', 'bedrock:DeleteModelInvocationLoggingConfiguration'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });

    // Subscription filter: Bedrock logs → usage-tracker Lambda
    new logs.SubscriptionFilter(this, 'BedrockLogsToUsageTracker', {
      logGroup: bedrockLogGroup,
      destination: new logsDest.LambdaDestination(trackerLambda),
      filterPattern: logs.FilterPattern.allEvents(),
    });
  }
}