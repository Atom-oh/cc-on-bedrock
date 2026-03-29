import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { CcOnBedrockConfig } from '../config/default';

export interface NetworkStackProps extends cdk.StackProps {
  config: CcOnBedrockConfig;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly isolatedSubnets: ec2.ISubnet[];
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    // VPC with custom subnets
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: config.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 23,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;
    this.isolatedSubnets = this.vpc.isolatedSubnets;

    // VPC Endpoints - Interface
    const interfaceEndpoints: { [key: string]: ec2.InterfaceVpcEndpointAwsService } = {
      ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
      ssmMessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      ec2Messages: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      ecrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      ecrDkr: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      bedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      cloudwatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    };

    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // VPC Endpoint - Gateway (S3)
    this.vpc.addGatewayEndpoint('s3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Route 53 Hosted Zone: lookup existing if hostedZoneId provided, else create new
    if (config.hostedZoneId) {
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName,
      });
    } else {
      this.hostedZone = new route53.HostedZone(this, 'HostedZone', {
        zoneName: config.domainName,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: 'cc-vpc-id' });
    new cdk.CfnOutput(this, 'HostedZoneId', { value: this.hostedZone.hostedZoneId, exportName: 'cc-hosted-zone-id' });
  }
}
