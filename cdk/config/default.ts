export interface CcOnBedrockConfig {
  // Project
  projectPrefix: string;

  // Network
  vpcName: string;
  vpcCidr: string;
  publicSubnetCidrA: string;
  publicSubnetCidrC: string;
  privateSubnetCidrA: string;
  privateSubnetCidrC: string;
  isolatedSubnetCidrA: string;
  isolatedSubnetCidrC: string;

  // Domain
  domainName: string;
  hostedZoneId?: string;
  devSubdomain: string;
  dashboardSubdomain: string;
  cognitoDomainPrefix: string;

  // Models
  opusModelId: string;
  sonnetModelId: string;

  // Compute
  ecsHostInstanceType: string;
  ecsClusterName: string;
  dashboardInstanceType: string;
  nodeVersion: string;

  // Budget
  dailyBudgetUsd: number;

  // Storage mode
  // 'ebs' = enterprise mode with warm-stop, idle-check, snapshot/resize lifecycle
  // 'efs' = simple mode, EFS-only, no EBS lifecycle management
  storageType: 'efs' | 'ebs';

  // CloudFront Prefix List (region-specific)
  cloudfrontPrefixListId: string;
}

export function isEbsMode(config: CcOnBedrockConfig): boolean {
  return config.storageType === 'ebs';
}

// Region-specific CloudFront Managed Prefix List IDs
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/LocationsOfEdgeServers.html
export const CLOUDFRONT_PREFIX_LISTS: Record<string, string> = {
  'ap-northeast-2': 'pl-22a6434b',  // Seoul
  'us-east-1': 'pl-3b927c52',       // N. Virginia
  'us-west-2': 'pl-82a045eb',       // Oregon
  'eu-west-1': 'pl-4fa04526',       // Ireland
  'ap-northeast-1': 'pl-58a04531',  // Tokyo
  'ap-southeast-1': 'pl-31a34658',  // Singapore
};

export const defaultConfig: CcOnBedrockConfig = {
  projectPrefix: 'cc-on-bedrock',
  vpcName: 'cc-on-bedrock-vpc',
  vpcCidr: '10.100.0.0/16',
  publicSubnetCidrA: '10.100.1.0/24',
  publicSubnetCidrC: '10.100.2.0/24',
  privateSubnetCidrA: '10.100.16.0/20',
  privateSubnetCidrC: '10.100.32.0/20',
  isolatedSubnetCidrA: '10.100.100.0/23',
  isolatedSubnetCidrC: '10.100.102.0/23',
  domainName: 'atomai.click',
  hostedZoneId: '',  // Set via cdk.context.json or -c hostedZoneId=xxx
  devSubdomain: 'dev',
  dashboardSubdomain: 'cconbedrock-dashboard',
  cognitoDomainPrefix: 'cc-on-bedrock-ent',
  opusModelId: 'global.anthropic.claude-opus-4-6-v1[1m]',
  sonnetModelId: 'global.anthropic.claude-sonnet-4-6[1m]',
  ecsHostInstanceType: 'm7g.4xlarge',
  ecsClusterName: 'cc-on-bedrock-devenv',
  dashboardInstanceType: 't4g.xlarge',
  nodeVersion: 'v20.18.3',
  dailyBudgetUsd: 50,
  storageType: 'ebs',
  cloudfrontPrefixListId: 'pl-22a6434b',  // ap-northeast-2 default
};
