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

    const { encryptionKey, userPool } = props;

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
        ECS_CLUSTER_NAME: 'cc-on-bedrock-devenv',
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
        ECS_CLUSTER_NAME: 'cc-on-bedrock-devenv',
        DAILY_BUDGET_USD: '50',
        SNS_TOPIC_ARN: alertTopic.topicArn,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.usageTable.grantReadData(budgetCheckLambda);
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

    // Outputs
    new cdk.CfnOutput(this, 'UsageTableName', {
      value: this.usageTable.tableName,
      exportName: 'cc-usage-table-name',
    });
    new cdk.CfnOutput(this, 'UsageTableArn', {
      value: this.usageTable.tableArn,
      exportName: 'cc-usage-table-arn',
    });
  }
}
