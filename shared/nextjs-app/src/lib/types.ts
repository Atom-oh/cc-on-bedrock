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
  storageType?: "efs" | "ebs";
  containerId?: string;
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
  storageType?: "efs" | "ebs";
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
}

export interface UpdateUserInput {
  username: string;
  containerOs?: "ubuntu" | "al2023";
  resourceTier?: "light" | "standard" | "power";
  securityPolicy?: "open" | "restricted" | "locked";
}

// ─── Usage Analytics Types (legacy LiteLLM format, used by analytics pages) ───

export interface LiteLLMKey {
  key: string;
  key_name: string;
  key_alias?: string;
  spend: number;
  max_budget?: number;
  max_parallel_requests?: number;
  tpm_limit?: number;
  rpm_limit?: number;
  models: string[];
  user_id: string;
  expires?: string;
}

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

export interface ProxyHealth {
  status: string;
  version?: string;
  uptime?: number;
  last_updated?: string;
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
}

export interface StartContainerInput {
  username: string;
  subdomain: string;
  department: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  storageType?: "efs" | "ebs";
}

// ─── Enterprise Types (Department, Budget, Portal) ───

export interface DepartmentListItem {
  department: string;
  userCount: number;
  activeContainers: number;
  memberCount: number;
  totalCost: number;
  totalTokens: number;
  requests: number;
  budgetUtilization: number;
  monthlyBudget: number;
  pendingCount: number;
}

export interface DeptBudget {
  department: string;
  dailyBudget?: number;
  monthlyBudget: number;
  currentSpend: number;
  monthlyTokenLimit: number;
  currentTokens: number;
}

export interface PendingRequest {
  requestId?: string;
  id?: string;
  userId?: string;
  email?: string;
  subdomain?: string;
  containerOs?: string;
  resourceTier?: string;
  department?: string;
  type?: string;
  status?: string;
  createdAt?: string;
  requestedAt?: string;
}

export interface DeptMember {
  username: string;
  email: string;
  subdomain: string;
  containerOs?: string;
  resourceTier?: string;
  enabled: boolean;
  status?: string;
  containerStatus?: string;
}

export interface MonthlyUsage {
  date: string;
  cost: number;
  tokens: number;
  requests: number;
}

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  used: number;
  total: number;
  path: string;
  percentage: number;
  usagePercent: number;
  [key: string]: unknown;
}

export interface EbsResizeData {
  volumeId?: string;
  currentSizeGb?: number;
  requestedSizeGb?: number;
  resizeRequest?: Record<string, unknown>;
  [key: string]: unknown;
}

export type UserPortalTab = "environment" | "storage" | "settings";

export const TIER_CONFIG = {
  light: { cpu: 1024, memory: 4096, label: "Light (1 vCPU / 4GB)", costMultiplier: 1 },
  standard: { cpu: 2048, memory: 8192, label: "Standard (2 vCPU / 8GB)", costMultiplier: 2 },
  power: { cpu: 4096, memory: 12288, label: "Power (4 vCPU / 12GB)", costMultiplier: 4 },
} as const;

export interface ProvisioningEvent {
  step: number;
  name: string;
  status: string;
  message?: string;
  error?: string;
  url?: string;
}

export const PROVISIONING_STEPS = [
  { step: 1, name: "iam_role", label: "Creating IAM Role" },
  { step: 2, name: "launching", label: "Launching Container" },
  { step: 3, name: "wait_ip", label: "Waiting for IP" },
  { step: 4, name: "route_register", label: "Registering Route" },
  { step: 5, name: "health_check", label: "Health Check" },
] as const;

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
