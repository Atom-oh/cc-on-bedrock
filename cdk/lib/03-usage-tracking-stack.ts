import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
      resources: [
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/${config.ecsClusterName}`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/${config.ecsClusterName}/*`,
      ],
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
        USER_BUDGETS_TABLE: 'cc-user-budgets',
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
      resources: [
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/${config.ecsClusterName}`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/${config.ecsClusterName}/*`,
      ],
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

    // Grant budget check Lambda read/write access to budget tables (writes currentSpend)
    departmentBudgetsTable.grantReadWriteData(budgetCheckLambda);
    userBudgetsTable.grantReadWriteData(budgetCheckLambda);

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
        ROUTING_TABLE: 'cc-routing-table',
        IDLE_THRESHOLD_MINUTES: '30',
        SNS_TOPIC_ARN: alertTopic.topicArn,
        EBS_LIFECYCLE_LAMBDA: 'cc-on-bedrock-ebs-lifecycle',
        USAGE_TABLE: this.usageTable.tableName,
        EOD_SHUTDOWN_ENABLED: 'true',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant warm-stop Lambda permissions
    userVolumesTable.grantReadWriteData(warmStopLambda);
    this.usageTable.grantReadData(warmStopLambda);
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

    // DynamoDB routing table: deregister routes on warm-stop
    warmStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:DeleteItem'],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-routing-table`,
      ],
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
      resources: [
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/${config.ecsClusterName}`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/${config.ecsClusterName}/*`,
      ],
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

    // ─── EC2 Idle Stop Lambda (computeMode: 'ec2') ───
    const ec2IdleStopLambda = new lambda.Function(this, 'Ec2IdleStopLambda', {
      functionName: 'cc-on-bedrock-ec2-idle-stop',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'ec2-idle-stop.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        REGION: cdk.Aws.REGION,
        INSTANCE_TABLE: 'cc-user-instances',
        ROUTING_TABLE: 'cc-routing-table',
        USAGE_TABLE: this.usageTable.tableName,
        IDLE_THRESHOLD_MINUTES: '30',
        SNS_TOPIC_ARN: alertTopic.topicArn,
        EOD_SHUTDOWN_ENABLED: 'true',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // EC2 idle-stop permissions
    ec2IdleStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:StopInstances'],
      resources: ['*'],
    }));
    ec2IdleStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    ec2IdleStopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-instances`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-routing-table`,
      ],
    }));
    this.usageTable.grantReadData(ec2IdleStopLambda);
    alertTopic.grantPublish(ec2IdleStopLambda);

    // EventBridge: EC2 idle check every 5 minutes
    const ec2IdleCheckRule = new events.Rule(this, 'Ec2IdleCheckRule', {
      ruleName: 'cc-ec2-idle-check',
      description: 'Check for idle EC2 devenv instances every 5 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    ec2IdleCheckRule.addTarget(new targets.LambdaFunction(ec2IdleStopLambda, {
      event: events.RuleTargetInput.fromObject({ action: 'check_idle' }),
    }));

    // EventBridge: EC2 EOD shutdown (18:00 KST)
    const ec2EodRule = new events.Rule(this, 'Ec2EodShutdownRule', {
      ruleName: 'cc-ec2-eod-shutdown',
      schedule: events.Schedule.cron({ hour: '9', minute: '0' }),
    });
    ec2EodRule.addTarget(new targets.LambdaFunction(ec2IdleStopLambda, {
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
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging-v2'),
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
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging-v2'),
      },
      // No onDelete — keep logging enabled even if stack is deleted/updated
      // Previous onDelete disabled logging during CDK rollbacks
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
      filterPattern: logs.FilterPattern.stringValue('$.identity.arn', '=', '*cc-on-bedrock-task*'),
    });

    // Approval Requests Table (container request workflow)
    const approvalTable = new dynamodb.Table(this, 'ApprovalRequestsTable', {
      tableName: 'cc-on-bedrock-approval-requests',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    approvalTable.addGlobalSecondaryIndex({
      indexName: 'department-status-index',
      partitionKey: { name: 'department', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    // ─── CUR 2.0 Data Export with IAM Principal Cost Allocation ───
    // Enables per-user Bedrock cost tracking in Cost Explorer and CUR 2.0
    // Ref: https://aws.amazon.com/about-aws/whats-new/2026/04/bedrock-iam-cost-allocation/

    const costReportBucket = new s3.Bucket(this, 'CostReportBucket', {
      bucketName: `${config.projectPrefix}-cost-reports-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // BCM Data Exports requires bucket policy granting access
    costReportBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBCMDataExports',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('bcm-data-exports.amazonaws.com')],
      actions: ['s3:PutObject', 's3:GetBucketPolicy'],
      resources: [
        costReportBucket.bucketArn,
        `${costReportBucket.bucketArn}/*`,
      ],
      conditions: {
        StringLike: {
          'aws:SourceArn': `arn:aws:bcm-data-exports:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:export/*`,
        },
      },
    }));

    // CUR 2.0 Data Export with caller identity (IAM principal) allocation
    new cr.AwsCustomResource(this, 'CUR2DataExport', {
      onCreate: {
        service: '@aws-sdk/client-bcm-data-exports',
        action: 'CreateExport',
        parameters: {
          Export: {
            Name: 'cc-on-bedrock-bedrock-cost-by-iam',
            DataQuery: {
              QueryStatement: [
                'SELECT identity_line_item_id, line_item_usage_account_id,',
                'line_item_product_code, line_item_usage_type,',
                'line_item_operation, line_item_unblended_cost,',
                'line_item_usage_amount, resource_tags_user_username,',
                'resource_tags_user_department, resource_tags_user_project,',
                'line_item_usage_start_date, line_item_usage_end_date',
                'FROM COST_AND_USAGE_REPORT',
              ].join(' '),
              TableConfigurations: {
                COST_AND_USAGE_REPORT: {
                  TIME_GRANULARITY: 'DAILY',
                  INCLUDE_RESOURCES: 'TRUE',
                  INCLUDE_CALLER_IDENTITY: 'TRUE',
                },
              },
            },
            DestinationConfigurations: {
              S3Destination: {
                S3Bucket: costReportBucket.bucketName,
                S3Prefix: 'cur2',
                S3Region: cdk.Aws.REGION,
                S3OutputConfigurations: {
                  OutputType: 'CUSTOM',
                  Format: 'PARQUET',
                  Compression: 'PARQUET',
                  Overwrite: 'OVERWRITE_REPORT',
                },
              },
            },
            RefreshCadence: {
              Frequency: 'SYNCHRONOUS',
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('cc-on-bedrock-cur2-export'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bcm-data-exports:CreateExport',
            'bcm-data-exports:DeleteExport',
            'bcm-data-exports:GetExport',
            'bcm-data-exports:UpdateExport',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['cur:PutReportDefinition', 'cur:DeleteReportDefinition'],
          resources: ['*'],
        }),
      ]),
    });

    new cdk.CfnOutput(this, 'CostReportBucketName', {
      value: costReportBucket.bucketName,
      description: 'S3 bucket for CUR 2.0 cost reports with IAM principal allocation',
    });
  }
}