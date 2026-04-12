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
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';
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

    // DLP Domain Lists table (DNS Firewall domain management)
    new dynamodb.Table(this, 'DlpDomainListTable', {
      tableName: 'cc-dlp-domain-lists',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
        COGNITO_USER_POOL_ID: userPool.userPoolId,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant Lambda permissions
    this.usageTable.grantReadWriteData(trackerLambda);
    trackerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));
    trackerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers'],
      resources: [userPool.userPoolArn],
    }));
    trackerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers'],
      resources: [userPool.userPoolArn],
    }));

    // EventBridge Rule: Bedrock API calls from CloudTrail (only cc-on-bedrock-task-* roles)
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
          userIdentity: {
            sessionContext: {
              sessionIssuer: {
                userName: [{ prefix: 'cc-on-bedrock-task-' }],
              },
            },
          },
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

    // ==================== EC2 Idle Stop (EC2-only mode) ====================
    // ECS warm-stop, idle-check, ebs-lifecycle Lambdas REMOVED (ADR-004)
    // EC2 Stop/Start preserves EBS — no snapshot/restore needed

    // ─── EC2 Idle Stop Lambda ───
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

    // ==================== MCP Gateway Management ====================

    // MCP Catalog table — available MCP tools that Admin can assign to departments
    const mcpCatalogTable = new dynamodb.Table(this, 'McpCatalogTable', {
      tableName: 'cc-mcp-catalog',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Department MCP Config table — per-department Gateway state + MCP assignments
    const deptMcpConfigTable = new dynamodb.Table(this, 'DeptMcpConfigTable', {
      tableName: 'cc-dept-mcp-config',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // DLQ for Gateway Manager Lambda failures
    const gatewayManagerDlq = new sqs.Queue(this, 'GatewayManagerDlq', {
      queueName: 'cc-gateway-manager-dlq',
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // K3: DLQ alarm — notify when failed events arrive
    new cloudwatch.Alarm(this, 'GatewayManagerDlqAlarm', {
      alarmName: 'cc-gateway-manager-dlq-messages',
      alarmDescription: 'Gateway Manager Lambda has failed events in DLQ',
      metric: gatewayManagerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Gateway Manager Lambda — manages per-department AgentCore Gateway lifecycle
    const gatewayManagerLambda = new lambda.Function(this, 'GatewayManagerLambda', {
      functionName: 'cc-on-bedrock-gateway-manager',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'gateway-manager.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        REGION: cdk.Aws.REGION,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        MCP_CATALOG_TABLE: mcpCatalogTable.tableName,
        DEPT_MCP_CONFIG_TABLE: deptMcpConfigTable.tableName,
        DEPT_BUDGETS_TABLE: 'cc-department-budgets',
        SNS_TOPIC_ARN: alertTopic.topicArn,
        PERMISSION_BOUNDARY_NAME: 'cc-on-bedrock-task-boundary',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant Gateway Manager Lambda permissions
    mcpCatalogTable.grantReadData(gatewayManagerLambda);
    deptMcpConfigTable.grantReadWriteData(gatewayManagerLambda);
    departmentBudgetsTable.grantReadWriteData(gatewayManagerLambda);
    alertTopic.grantPublish(gatewayManagerLambda);

    // AgentCore Gateway management permissions
    gatewayManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreGatewayManagement',
      actions: [
        'bedrock-agentcore-control:CreateGateway',
        'bedrock-agentcore-control:DeleteGateway',
        'bedrock-agentcore-control:GetGateway',
        'bedrock-agentcore-control:ListGateways',
        'bedrock-agentcore-control:CreateGatewayTarget',
        'bedrock-agentcore-control:DeleteGatewayTarget',
        'bedrock-agentcore-control:GetGatewayTarget',
        'bedrock-agentcore-control:ListGatewayTargets',
        'bedrock-agentcore-control:SynchronizeGatewayTargets',
      ],
      resources: ['*'],
    }));

    // C3: IAM permissions — AttachRolePolicy for admin approval workflow + PassRole with condition
    gatewayManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamGatewayRoleManagement',
      actions: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'],
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-agentcore-gateway-*`,
      ],
    }));
    gatewayManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IamPassRoleToAgentCore',
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cc-on-bedrock-agentcore-gateway-*`,
      ],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'bedrock-agentcore.amazonaws.com',
        },
      },
    }));

    // Lambda invoke permission (for registering Lambda targets)
    gatewayManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'LambdaInvoke',
      actions: ['lambda:GetFunction', 'lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:cc-on-bedrock-mcp-*`],
    }));

    // DDB Streams trigger for Gateway Manager Lambda
    gatewayManagerLambda.addEventSource(new lambdaEventSources.DynamoEventSource(deptMcpConfigTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(gatewayManagerDlq),
    }));

    // Outputs
    new cdk.CfnOutput(this, 'McpCatalogTableName', { value: mcpCatalogTable.tableName });
    new cdk.CfnOutput(this, 'DeptMcpConfigTableName', { value: deptMcpConfigTable.tableName });
    new cdk.CfnOutput(this, 'GatewayManagerLambdaArn', { value: gatewayManagerLambda.functionArn });

    // ─── CUR 2.0 Data Export (TODO) ───
    // INCLUDE_CALLER_IDENTITY is not yet available in BCM Data Exports API.
    // Re-enable when AWS adds this TableConfigurations property.
    // Ref: https://aws.amazon.com/about-aws/whats-new/2026/04/bedrock-iam-cost-allocation/
  }
}