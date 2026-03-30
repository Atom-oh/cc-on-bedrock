// ─── Auth & User Types ───

export interface UserSession {
  id: string;
  email: string;
  name?: string;
  groups: string[];
  isAdmin: boolean;
  subdomain?: string;
  containerOs?: "ubuntu" | "al2023";
  resourceTier?: "light" | "standard" | "power";
  securityPolicy?: "open" | "restricted" | "locked";
  litellmApiKey?: string;
  containerId?: string;
  storageType?: "ebs" | "efs";
}

export interface CognitoUser {
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  createdAt: string;
  subdomain: string;
  department: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  storageType?: "ebs" | "efs";
  litellmApiKey?: string;
  containerId?: string;
  groups: string[];
}

export interface CreateUserInput {
  email: string;
  subdomain: string;
  department: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  storageType: "ebs" | "efs";
}

export interface UpdateUserInput {
  username: string;
  containerOs?: "ubuntu" | "al2023";
  resourceTier?: "light" | "standard" | "power";
  securityPolicy?: "open" | "restricted" | "locked";
  storageType?: "ebs" | "efs";
}

// ─── Usage Analytics Types ───

export interface SpendLog {
  request_id: string;
  api_key: string;
  model: string;
  call_type: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  startTime: string;
  endTime: string;
  user: string;
  status: string;
}

export interface ModelMetrics {
  model: string;
  num_requests: number;
  total_tokens: number;
  avg_latency_seconds: number;
  total_spend: number;
}

export interface SpendSummary {
  date: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  architecture: string;
  version?: string;
  model_count?: number;
}

// ─── ECS / Container Types ───

export interface ContainerInfo {
  taskArn: string;
  taskId: string;
  status: string;
  desiredStatus: string;
  username: string;
  subdomain: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  cpu: string;
  memory: string;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  healthStatus?: string;
  privateIp?: string;
  storageType?: "ebs" | "efs";
}

export interface StartContainerInput {
  username: string;
  subdomain: string;
  department: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  storageType?: "ebs" | "efs";
}

// ─── Usage Tracking Types (CloudTrail → DynamoDB) ───

export interface UsageRecord {
  userId: string;
  department: string;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCost: number;
}

export interface DepartmentUsage {
  department: string;
  users: number;
  totalTokens: number;
  totalCost: number;
  requests: number;
}

// ─── Department Dashboard Types ───

export interface DeptMember {
  username: string;
  email: string;
  subdomain: string;
  containerOs: string;
  resourceTier: string;
  status: string;
  containerStatus?: string;
}

export interface DeptBudget {
  department: string;
  monthlyBudget: number;
  currentSpend: number;
  monthlyTokenLimit: number;
  currentTokens: number;
}

export interface PendingRequest {
  requestId: string;
  email: string;
  subdomain: string;
  containerOs: string;
  resourceTier: string;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  department: string;
}

export interface MonthlyUsage {
  date: string;
  cost: number;
  tokens: number;
}

export interface DepartmentListItem {
  department: string;
  memberCount: number;
  totalCost: number;
  totalTokens: number;
  requests: number;
  budgetUtilization: number;
  monthlyBudget: number;
  pendingCount: number;
}

export interface UserUsage {
  userId: string;
  department: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  requests: number;
  lastActive: string;
}

export interface StopContainerInput {
  taskArn: string;
  reason?: string;
}

// ─── Dashboard / Chart Types ───

export interface TokenUsageData {
  date: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ModelRatioData {
  name: string;
  value: number;
}

export interface CostTrendData {
  date: string;
  cost: number;
}

export interface StatCardData {
  title: string;
  value: string | number;
  description?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export interface HealthStatus {
  service: string;
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  lastChecked: string;
  details?: Record<string, unknown>;
}

// ─── Provisioning Types ───

export type ProvisioningStepName =
  | "iam_role"
  | "efs_access_point"
  | "task_definition"
  | "password_store"
  | "container_start"
  | "route_register"
  | "health_check";

export interface ProvisioningEvent {
  step: number;
  name: ProvisioningStepName;
  status: "pending" | "in_progress" | "completed" | "failed";
  message?: string;
  error?: string;
  url?: string; // final code-server URL on completion
}

export const PROVISIONING_STEPS: { step: number; name: ProvisioningStepName; label: string }[] = [
  { step: 1, name: "iam_role", label: "Setting up permissions" },
  { step: 2, name: "efs_access_point", label: "Preparing storage" },
  { step: 3, name: "task_definition", label: "Configuring environment" },
  { step: 4, name: "password_store", label: "Securing access" },
  { step: 5, name: "container_start", label: "Starting container" },
  { step: 6, name: "route_register", label: "Connecting network" },
  { step: 7, name: "health_check", label: "Verifying code-server" },
];

// ─── Disk Usage Types ───

export interface DiskUsage {
  storageType: "ebs" | "efs";
  total: number;
  used: number;
  available: number;
  usagePercent: number;
  mountPath: string;
}

export interface EbsResizeRequest {
  requestedSizeGb: number;
  reason: string;
  status: "resize_pending" | "approved" | "rejected" | "completed";
  requestedAt: string;
  updatedAt?: string;
  approvedBy?: string;
}

export interface EbsResizeData {
  userId: string;
  currentSizeGb: number;
  volumeId?: string;
  resizeRequest: EbsResizeRequest | null;
}

// ─── Password Management Types ───

export interface PasswordInfo {
  password: string;
  lastChanged?: string;
}

// ─── User Portal Tab Types ───

export type UserPortalTab = "environment" | "storage" | "settings";

export const TIER_CONFIG = {
  light: { label: "Light", cpu: "1 vCPU", memory: "2 GB", costMultiplier: 1 },
  standard: { label: "Standard", cpu: "2 vCPU", memory: "4 GB", costMultiplier: 2 },
  power: { label: "Power", cpu: "4 vCPU", memory: "8 GB", costMultiplier: 4 },
} as const;

// ─── API Response Types ───

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}
