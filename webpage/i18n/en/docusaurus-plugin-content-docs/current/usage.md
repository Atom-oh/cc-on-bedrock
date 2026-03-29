# Usage

import Screenshot from '@site/src/components/Screenshot';

This guide explains how to manage infrastructure and collaborate with the AI Assistant using the CC-on-Bedrock dashboard.

## 1. Home
The first screen you see after logging into the dashboard, providing an at-a-glance overview of key platform metrics.

<Screenshot 
  src="/img/home.png" 
  alt="Dashboard Home" 
  caption="Platform Overview: Cost, token usage, active containers, and cluster metrics" 
/>

- **Key Metrics**: Check total cost for today, total tokens consumed, and the number of running ECS tasks.
- **Resource Status**: Monitor CPU and memory reservation trends through real-time graphs.

## 2. AI Assistant
An intelligent assistant that provides real-time streaming responses using Amazon Bedrock's Converse API.

<Screenshot 
  src="/img/AI_Assistant.png" 
  alt="AI Assistant" 
  caption="Intelligent chat interface powered by Bedrock Converse API + Tool Use" 
/>

- **Fast Streaming**: Token-by-token real-time responses for seamless conversation.
- **Tool Use**: The AI directly calls built-in tools for infrastructure lookup, code analysis, and more.
- **Context Sharing**: Perfect conversational context retention via AgentCore Memory.

## 3. Analytics
Provides tools for deep analysis of platform usage and cost trends.

<Screenshot 
  src="/img/Analytics01.png" 
  alt="Analytics Trends" 
  caption="Cost trends and usage analysis by model and department" 
/>

- **Cost Trends**: Visualize daily/weekly cost fluctuations with line graphs.
- **Distribution Analysis**: Check usage shares by department and model using pie charts.

<Screenshot 
  src="/img/Analytics02.png" 
  alt="Analytics Leaderboard" 
  caption="User usage leaderboard and detailed statistics" 
/>

- **Leaderboard**: See rankings of users who utilize resources most effectively.

## 4. Monitoring
Real-time surveillance of infrastructure health and performance.

<Screenshot 
  src="/img/monitoring.png" 
  alt="Infrastructure Monitoring" 
  caption="Visualization of ECS performance metrics via Container Insights" 
/>

- **Container Insights**: Detailed monitoring of CPU, memory, and network usage for individual tasks and services.
- **Health Check**: Real-time availability checks for ECS clusters and services.

## 5. Security
Centrally manage security policies and threat defense status.

<Screenshot 
  src="/img/security.png" 
  alt="Security Dashboard" 
  caption="Unified management of IAM policies, DLP status, and DNS Firewall logs" 
/>

- **DLP Control**: Set Data Loss Prevention policies (Open/Restricted/Locked) based on security groups.
- **Threat Audit**: Review logs of malicious domains blocked by DNS Firewall and CloudTrail audit logs.

## 6. User Management
Manage user accounts and permissions integrated with Amazon Cognito.

<Screenshot 
  src="/img/user.png" 
  alt="User Management" 
  caption="Cognito-based user list and account status management" 
/>

- **Account Control**: Create, update, and delete users; assign departments and permissions.
- **Filtering**: Sort and search users by operating system (OS) and tier.

## 7. Container Management
Directly control individual developer environments (ECS Tasks).

<Screenshot 
  src="/img/containers.png" 
  alt="Container Management" 
  caption="ECS Task lifecycle control and EFS file system management" 
/>

- **Task Control**: Start, stop, or restart containers for each user and access the terminal.
- **Duplicate Prevention**: Automated control logic ensures only one task runs per user.
