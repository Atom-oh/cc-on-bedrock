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
}

export interface CognitoUser {
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  createdAt: string;
  subdomain: string;
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  litellmApiKey?: string;
  containerId?: string;
  groups: string[];
}

export interface CreateUserInput {
  email: string;
  subdomain: string;
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

// ─── LiteLLM Types ───

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
  containerOs: "ubuntu" | "al2023";
  resourceTier: "light" | "standard" | "power";
  securityPolicy: "open" | "restricted" | "locked";
  litellmApiKey: string;
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
