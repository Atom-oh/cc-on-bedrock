# Security

import SecurityLayers from '@site/src/components/InteractiveDoc/SecurityLayers';
import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock implements a **7-Layer Security Model** designed for safe use in enterprise environments.

<SecurityLayers />

## Security Management Dashboard
Centrally manage security policies and monitor threat logs in real-time.

<Screenshot 
  src="/img/security.png" 
  alt="Security Dashboard" 
  caption="Unified Security Dashboard: Integrated management of IAM, DLP, and DNS Firewall" 
/>

## 7-Layer Security Model Detail

| Layer | Component | Key Protection Features |
|-------|-----------|------------|
| L1 | CloudFront | HTTPS Encryption (TLS 1.2+), AWS Shield DDoS Protection |
| L2 | ALB | Access blocked via CloudFront Prefix List and X-Custom-Secret header |
| L3 | Cognito | OAuth 2.0 Authentication, Admin/User group-based access control |
| L4 | Security Groups | 3-stage Data Loss Prevention (DLP): Open / Restricted / Locked policies |
| L5 | VPC Endpoints | Internal transmission avoiding the internet via AWS Private Link |
| L6 | DNS Firewall | 5 AWS threat lists and custom block lists applied |
| L7 | IAM + DLP | Per-model access control, budget Deny Policy, file transfer restrictions |

## Data Loss Prevention (DLP) Policy

Network environments of development instances can be dynamically managed through Security Groups:

- **Open**: Free internet outbound allowed (default).
- **Restricted**: Only predefined specific domains (e.g., GitHub, npm) are allowed.
- **Locked**: All internet outbound blocked; only AWS service access via VPC endpoints is allowed.
