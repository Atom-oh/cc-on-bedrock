import React, { useState } from 'react';
import styles from './DeploymentFlow.module.css';

const steps = [
  { id: 1, title: 'Network (01)', desc: 'VPC, NAT Gateway, Endpoints, DNS Firewall' },
  { id: 2, title: 'Security (02)', desc: 'Cognito, KMS, Secrets Manager, IAM Roles' },
  { id: 3, title: 'Usage Tracking (03)', desc: 'CloudTrail, EventBridge, Lambda, DynamoDB' },
  { id: 4, title: 'ECS DevEnv (04)', desc: 'Cluster, Task Definitions, EFS, ALB, CloudFront' },
  { id: 5, title: 'Dashboard (05)', desc: 'Next.js App, ASG, ALB, CloudFront, S3' },
];

export default function DeploymentFlow() {
  const [activeStep, setActiveStep] = useState(1);

  return (
    <div className={styles.container}>
      <h3>단계별 배포 프로세스 (Deployment Pipeline)</h3>
      <div className={styles.pipeline}>
        {steps.map((step) => (
          <div 
            key={step.id} 
            className={`${styles.step} ${activeStep === step.id ? styles.active : ''} ${activeStep > step.id ? styles.completed : ''}`}
            onClick={() => setActiveStep(step.id)}
          >
            <div className={styles.circle}>{step.id}</div>
            <div className={styles.label}>{step.title}</div>
          </div>
        ))}
      </div>
      <div className={styles.detailBox}>
        <h4>Step {activeStep}: {steps[activeStep-1].title}</h4>
        <p>{steps[activeStep-1].desc}</p>
        <div className={styles.code}>
          <code>npx cdk deploy CcOnBedrock-{steps[activeStep-1].title.split(' ')[0]}</code>
        </div>
      </div>
    </div>
  );
}
