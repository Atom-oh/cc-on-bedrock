"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type Locale = "ko" | "en";

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: "ko",
  setLocale: () => {},
  t: (key) => key,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("cc-locale") as Locale) ?? "ko";
    }
    return "ko";
  });

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof window !== "undefined") {
      localStorage.setItem("cc-locale", l);
    }
  }, []);

  const t = useCallback(
    (key: string): string => {
      const dict = locale === "ko" ? ko : en;
      return (dict as Record<string, string>)[key] ?? key;
    },
    [locale]
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

// ─── Korean ───
const ko: Record<string, string> = {
  // Sidebar
  "nav.home": "홈",
  "nav.ai": "AI 어시스턴트",
  "nav.analytics": "분석",
  "nav.security": "보안",
  "nav.monitoring": "모니터링",
  "nav.users": "사용자",
  "nav.containers": "컨테이너",
  "nav.signout": "로그아웃",
  "nav.admin": "관리자",
  "nav.user": "사용자",

  // Analytics
  "analytics.title": "Claude Code Usage",
  "analytics.lastUpdated": "최종 업데이트",
  "analytics.loading": "분석 데이터 로딩 중...",
  "analytics.past1d": "1일",
  "analytics.past7d": "7일",
  "analytics.past30d": "30일",
  "analytics.refresh": "↻ 새로고침",

  // Overview
  "overview.title": "Overview",
  "overview.totalCost": "총 비용 (USD)",
  "overview.totalRequests": "총 API 요청 수",
  "overview.activeUsers": "활성 사용자 수",
  "overview.avgLatency": "평균 응답시간 (ms)",

  // Insights
  "insights.title": "Insights & 비용 분석",
  "insights.dailyBurn": "일일 Burn Rate",
  "insights.dailyBurnDesc": "현재 기간 일평균",
  "insights.monthlyProjection": "월간 비용 예측",
  "insights.monthlyProjectionDesc": "현재 속도 기준",
  "insights.avgCostPerReq": "요청당 평균 비용",
  "insights.avgCostPerReqDesc": "API 호출 단가",
  "insights.avgTokensPerReq": "요청당 평균 토큰",
  "insights.avgTokensPerReqDesc": "Input + Output",
  "insights.totalInput": "총 Input 토큰",
  "insights.totalOutput": "총 Output 토큰",
  "insights.budgetUtil": "예산 사용률",
  "insights.modelCount": "등록 모델 수",

  // System Health
  "system.title": "시스템 상태",
  "system.proxyStatus": "Proxy Status",
  "system.database": "Database",
  "system.cache": "Cache (Valkey)",
  "system.version": "LiteLLM Version",

  // Key Budget
  "keyBudget.title": "API Key 예산 관리",
  "keyBudget.alias": "Key Alias",
  "keyBudget.spend": "사용량",
  "keyBudget.limit": "한도",
  "keyBudget.usage": "사용률",
  "keyBudget.lastActive": "마지막 활동",

  // Bedrock Model
  "bedrockModel.title": "Bedrock 모델 상세",
  "bedrockModel.model": "Model",
  "bedrockModel.requests": "Requests",
  "bedrockModel.tokens": "Total Tokens",
  "bedrockModel.spend": "Spend (USD)",
  "bedrockModel.latency": "Avg Latency",
  "bedrockModel.ratio": "비율",

  // Leaderboard
  "leaderboard.title": "Leaderboard - 토큰 사용량 TOP",
  "leaderboard.totalTokens": "총 토큰 사용량 TOP 10",
  "leaderboard.inputTokens": "Input 토큰 TOP 10",
  "leaderboard.outputTokens": "Output 토큰 TOP 10",

  // Token Trends
  "tokenTrends.title": "토큰 사용량 (추이)",
  "tokenTrends.byType": "토큰 유형별 사용 추이",
  "tokenTrends.byUser": "사용자별 토큰 추이 (TOP 5)",
  "tokenTrends.dailyRequests": "일별 요청 수 추이",

  // Usage Patterns
  "usagePatterns.title": "사용 패턴",
  "usagePatterns.userRequests": "사용자별 API 요청 수",
  "usagePatterns.modelCost": "모델별 비용 (USD)",
  "usagePatterns.dailyCost": "일별 비용 (USD)",

  // Model Performance
  "modelPerf.title": "모델 성능",
  "modelPerf.latency": "모델별 평균 응답시간 (ms)",
  "modelPerf.userCost": "사용자별 비용 TOP 10 (USD)",

  // Monitoring
  "monitoring.title": "운영 모니터링",
  "monitoring.subtitle": "프록시 상태, ECS 현황, 활성 세션, 에러율",
  "monitoring.serviceHealth": "서비스 상태",
  "monitoring.resourceInsights": "리소스 인사이트",
  "monitoring.containerDist": "컨테이너 분포",
  "monitoring.osDist": "OS 분포",
  "monitoring.tierDist": "리소스 Tier 분포",
  "monitoring.activeSessions": "활성 세션",
  "monitoring.servicesHealthy": "서비스 정상",
  "monitoring.containersRunning": "컨테이너 실행 중",
  "monitoring.running": "실행 중",
  "monitoring.pending": "시작 중",
  "monitoring.totalVcpu": "총 vCPU",
  "monitoring.totalMemory": "총 Memory",
  "monitoring.allContainers": "전체 컨테이너",
  "monitoring.allocatedCpu": "할당 CPU",
  "monitoring.allocatedRam": "할당 RAM",
  "monitoring.allStates": "전체 상태",
  "monitoring.modelsConfigured": "모델 설정됨",

  // Users
  "users.title": "사용자 관리",
  "users.subtitle": "Cognito 사용자 CRUD, API 키 관리",
  "users.totalUsers": "전체 사용자",
  "users.active": "활성",
  "users.withApiKey": "API Key 보유",
  "users.canUseCC": "Claude Code 사용 가능",
  "users.osSplit": "OS 분포",
  "users.tierSplit": "Tier 분포",
  "users.securityDist": "Security Policy 분포",
  "users.registered": "등록됨",
  "users.enabled": "활성화",
  "users.createUser": "사용자 생성",

  // Containers
  "containers.title": "컨테이너 관리",
  "containers.subtitle": "ECS 개발환경 컨테이너 시작/중지/관리",
  "containers.running": "실행 중",
  "containers.pending": "시작 중",
  "containers.totalUsers": "전체 사용자",
  "containers.available": "사용 가능",
  "containers.utilization": "사용률",
  "containers.breakdown": "활성 컨테이너 분석",
  "containers.byOs": "OS별",
  "containers.byTier": "Tier별",
  "containers.startContainer": "컨테이너 시작",
  "containers.cancel": "취소",

  // User Model Insights
  "userModel.title": "사용자별 모델 사용 인사이트",
  "userModel.matrix": "사용자 × 모델 매트릭스",
  "userModel.preference": "모델 선호도 분포",
  "userModel.topByModel": "모델별 Top 사용자",
  "userModel.costByModel": "사용자별 모델 비용",
  "userModel.tokenEfficiency": "사용자별 토큰 효율",
  "userModel.user": "사용자",
  "userModel.requests": "요청",
  "userModel.tokens": "토큰",
  "userModel.spend": "비용",
  "userModel.avgTokens": "평균 토큰",
  "userModel.primaryModel": "주 모델",

  // Home
  "home.title": "CC-on-Bedrock",
  "home.subtitle": "AWS Bedrock 기반 멀티유저 Claude Code 개발환경",
  "home.totalCost": "총 비용",
  "home.totalRequests": "총 요청",
  "home.activeUsers": "활성 사용자",
  "home.runningContainers": "실행 컨테이너",
  "home.proxyStatus": "프록시 상태",
  "home.cacheStatus": "캐시 상태",
  "home.dbStatus": "DB 상태",
  "home.modelCount": "등록 모델",
  "home.quickActions": "빠른 작업",
  "home.viewAnalytics": "분석 대시보드",
  "home.viewMonitoring": "모니터링",
  "home.manageUsers": "사용자 관리",
  "home.manageContainers": "컨테이너 관리",
  "home.recentActivity": "최근 활동",

  // Common
  "common.refresh": "새로고침",
  "common.active": "활성",
  "common.startingUp": "시작 중",
  "common.registered": "등록됨",
  "common.canStart": "시작 가능",
};

// ─── English ───
const en: Record<string, string> = {
  // Sidebar
  "nav.home": "Home",
  "nav.ai": "AI Assistant",
  "nav.analytics": "Analytics",
  "nav.security": "Security",
  "nav.monitoring": "Monitoring",
  "nav.users": "Users",
  "nav.containers": "Containers",
  "nav.signout": "Sign out",
  "nav.admin": "Admin",
  "nav.user": "User",

  // Analytics
  "analytics.title": "Claude Code Usage",
  "analytics.lastUpdated": "Last updated",
  "analytics.loading": "Loading analytics...",
  "analytics.past1d": "1 Day",
  "analytics.past7d": "7 Days",
  "analytics.past30d": "30 Days",
  "analytics.refresh": "↻ Refresh",

  // Overview
  "overview.title": "Overview",
  "overview.totalCost": "Total Cost (USD)",
  "overview.totalRequests": "Total API Requests",
  "overview.activeUsers": "Active Users",
  "overview.avgLatency": "Avg Latency (ms)",

  // Insights
  "insights.title": "Insights & Cost Analysis",
  "insights.dailyBurn": "Daily Burn Rate",
  "insights.dailyBurnDesc": "Current period average",
  "insights.monthlyProjection": "Monthly Projection",
  "insights.monthlyProjectionDesc": "At current rate",
  "insights.avgCostPerReq": "Avg Cost / Request",
  "insights.avgCostPerReqDesc": "API call unit price",
  "insights.avgTokensPerReq": "Avg Tokens / Request",
  "insights.avgTokensPerReqDesc": "Input + Output",
  "insights.totalInput": "Total Input Tokens",
  "insights.totalOutput": "Total Output Tokens",
  "insights.budgetUtil": "Budget Utilization",
  "insights.modelCount": "Registered Models",

  // System Health
  "system.title": "System Health",
  "system.proxyStatus": "Proxy Status",
  "system.database": "Database",
  "system.cache": "Cache (Valkey)",
  "system.version": "LiteLLM Version",

  // Key Budget
  "keyBudget.title": "API Key Budget Management",
  "keyBudget.alias": "Key Alias",
  "keyBudget.spend": "Spend",
  "keyBudget.limit": "Limit",
  "keyBudget.usage": "Usage",
  "keyBudget.lastActive": "Last Active",

  // Bedrock Model
  "bedrockModel.title": "Bedrock Model Details",
  "bedrockModel.model": "Model",
  "bedrockModel.requests": "Requests",
  "bedrockModel.tokens": "Total Tokens",
  "bedrockModel.spend": "Spend (USD)",
  "bedrockModel.latency": "Avg Latency",
  "bedrockModel.ratio": "Ratio",

  // Leaderboard
  "leaderboard.title": "Leaderboard - Token Usage TOP",
  "leaderboard.totalTokens": "Total Tokens TOP 10",
  "leaderboard.inputTokens": "Input Tokens TOP 10",
  "leaderboard.outputTokens": "Output Tokens TOP 10",

  // Token Trends
  "tokenTrends.title": "Token Usage (Trends)",
  "tokenTrends.byType": "Token Usage by Type",
  "tokenTrends.byUser": "Token Usage by User (TOP 5)",
  "tokenTrends.dailyRequests": "Daily Request Trend",

  // Usage Patterns
  "usagePatterns.title": "Usage Patterns",
  "usagePatterns.userRequests": "API Requests by User",
  "usagePatterns.modelCost": "Cost by Model (USD)",
  "usagePatterns.dailyCost": "Daily Cost (USD)",

  // Model Performance
  "modelPerf.title": "Model Performance",
  "modelPerf.latency": "Avg Latency by Model (ms)",
  "modelPerf.userCost": "Cost by User TOP 10 (USD)",

  // Monitoring
  "monitoring.title": "Operations Monitoring",
  "monitoring.subtitle": "Proxy health, ECS status, active sessions, error rates",
  "monitoring.serviceHealth": "Service Health",
  "monitoring.resourceInsights": "Resource Insights",
  "monitoring.containerDist": "Container Distribution",
  "monitoring.osDist": "OS Distribution",
  "monitoring.tierDist": "Resource Tier Distribution",
  "monitoring.activeSessions": "Active Sessions",
  "monitoring.servicesHealthy": "Services Healthy",
  "monitoring.containersRunning": "containers running",
  "monitoring.running": "Running",
  "monitoring.pending": "Pending",
  "monitoring.totalVcpu": "Total vCPU",
  "monitoring.totalMemory": "Total Memory",
  "monitoring.allContainers": "All Containers",
  "monitoring.allocatedCpu": "Allocated CPU",
  "monitoring.allocatedRam": "Allocated RAM",
  "monitoring.allStates": "All states",
  "monitoring.modelsConfigured": "models configured",

  // Users
  "users.title": "User Management",
  "users.subtitle": "Cognito user CRUD, API key management",
  "users.totalUsers": "Total Users",
  "users.active": "Active",
  "users.withApiKey": "With API Key",
  "users.canUseCC": "Can use Claude Code",
  "users.osSplit": "OS Split",
  "users.tierSplit": "Tier Split",
  "users.securityDist": "Security Policy Distribution",
  "users.registered": "Registered",
  "users.enabled": "enabled",
  "users.createUser": "Create User",

  // Containers
  "containers.title": "Container Management",
  "containers.subtitle": "Start, stop, and manage ECS dev environment containers",
  "containers.running": "Running",
  "containers.pending": "Pending",
  "containers.totalUsers": "Total Users",
  "containers.available": "Available",
  "containers.utilization": "Utilization",
  "containers.breakdown": "Active Container Breakdown",
  "containers.byOs": "By OS",
  "containers.byTier": "By Tier",
  "containers.startContainer": "Start Container",
  "containers.cancel": "Cancel",

  // User Model Insights
  "userModel.title": "User × Model Usage Insights",
  "userModel.matrix": "User × Model Matrix",
  "userModel.preference": "Model Preference Distribution",
  "userModel.topByModel": "Top Users by Model",
  "userModel.costByModel": "Cost by User & Model",
  "userModel.tokenEfficiency": "Token Efficiency by User",
  "userModel.user": "User",
  "userModel.requests": "Requests",
  "userModel.tokens": "Tokens",
  "userModel.spend": "Spend",
  "userModel.avgTokens": "Avg Tokens",
  "userModel.primaryModel": "Primary Model",

  // Home
  "home.title": "CC-on-Bedrock",
  "home.subtitle": "Multi-user Claude Code Dev Environment on AWS Bedrock",
  "home.totalCost": "Total Cost",
  "home.totalRequests": "Total Requests",
  "home.activeUsers": "Active Users",
  "home.runningContainers": "Running Containers",
  "home.proxyStatus": "Proxy Status",
  "home.cacheStatus": "Cache Status",
  "home.dbStatus": "DB Status",
  "home.modelCount": "Models",
  "home.quickActions": "Quick Actions",
  "home.viewAnalytics": "Analytics Dashboard",
  "home.viewMonitoring": "Monitoring",
  "home.manageUsers": "User Management",
  "home.manageContainers": "Container Management",
  "home.recentActivity": "Recent Activity",

  // Common
  "common.refresh": "Refresh",
  "common.active": "Active",
  "common.startingUp": "Starting up",
  "common.registered": "Registered",
  "common.canStart": "Can start",
};
