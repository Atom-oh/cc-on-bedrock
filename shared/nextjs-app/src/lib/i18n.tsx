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
  "nav.myEnv": "내 환경",
  "nav.department": "부서 관리",
  "nav.ai": "AI 어시스턴트",
  "nav.analytics": "분석",
  "nav.security": "보안",
  "nav.monitoring": "모니터링",
  "nav.users": "사용자",
  "nav.containers": "인스턴스",
  "nav.tokens": "토큰 사용량",
  "nav.budgets": "예산 설정",
  "nav.approvals": "승인 관리",
  "nav.dlpManagement": "DLP 관리",
  "nav.docs": "가이드",
  "nav.signout": "로그아웃",
  "nav.admin": "관리자",
  "nav.user": "사용자",

  // User Portal
  "user.containerStatus": "인스턴스 상태",
  "user.os": "운영체제",
  "user.tier": "리소스 등급",
  "user.subdomain": "서브도메인",
  "user.start": "인스턴스 시작",
  "user.stop": "인스턴스 중지",
  "user.selectTier": "리소스 등급 선택",
  "user.starting": "시작 중...",
  "user.stopping": "중지 중...",
  "user.stopped": "중지됨",
  "user.openCodeServer": "code-server 열기",
  "user.dailyUsage": "오늘 사용량",
  "user.tokenUsage": "토큰 사용량",
  "user.ofDailyLimit": "일일 한도 대비",
  "user.requests": "API 요청 수",
  "user.estimatedCost": "예상 비용",
  "user.workspaceInfo": "워크스페이스 정보",
  "user.securityPolicy": "보안 정책",
  "user.policyOpen": "전체 네트워크 접근 허용",
  "user.policyRestricted": "제한된 외부 접근",
  "user.policyLocked": "외부 네트워크 차단",
  "user.accessUrl": "접속 URL",
  "user.noSubdomain": "서브도메인 미할당",

  // Department Dashboard
  "dept.budgetOverview": "월간 예산",
  "dept.costUsage": "비용 사용량",
  "dept.tokenUsage": "토큰 사용량",
  "dept.monthlyTrend": "월간 지출 추이",
  "dept.pendingApprovals": "승인 대기 요청",
  "dept.members": "부서원 목록",
  "dept.approve": "승인",
  "dept.reject": "거절",
  "dept.allDepartments": "전체 부서",
  "dept.overview": "부서 개요",
  "dept.budgetUtil": "예산 사용률",
  "dept.activeContainers": "활성 인스턴스",
  "dept.pendingCount": "승인 대기",
  "dept.totalMembers": "전체 인원",
  "dept.totalCost": "전체 비용",
  "dept.totalTokens": "전체 토큰",

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
  "overview.deptCount": "부서 수",

  // Department Analysis
  "dept.title": "부서별 분석",
  "dept.filterLabel": "부서",
  "dept.totalDepts": "총 부서 수",
  "dept.totalDeptsDesc": "활성 부서",
  "dept.topByCost": "비용 최다 부서",
  "dept.topByTokens": "토큰 최다 부서",
  "dept.topByUsers": "인원 최다 부서",
  "dept.users": "명",
  "dept.costByDept": "부서별 비용 (USD)",
  "dept.requestsByDept": "부서별 요청 수",
  "dept.tokenDistribution": "부서별 토큰 분포",
  "dept.totalTokensLabel": "총 토큰",

  // User x Department Insights
  "userDept.title": "사용자 × 부서 인사이트",
  "userDept.tableTitle": "사용자별 부서/모델/토큰/비용 상세",
  "userDept.user": "사용자",
  "userDept.department": "부서",
  "userDept.modelsUsed": "사용 모델",
  "userDept.requests": "요청 수",
  "userDept.inputTokens": "Input 토큰",
  "userDept.outputTokens": "Output 토큰",
  "userDept.totalCost": "총 비용",
  "userDept.avgTokensPerReq": "평균 토큰/요청",

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
  "system.bedrockStatus": "Bedrock API",
  "system.database": "사용량 추적 (DynamoDB)",
  "system.architecture": "아키텍처",
  "system.version": "Direct Bedrock",

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
  "modelPerf.usageDistribution": "모델 사용 분포",
  "modelPerf.totalRequests": "총 요청",
  "modelPerf.summaryTable": "모델별 요청/토큰/비용 요약",

  // Monitoring
  "monitoring.title": "운영 모니터링",
  "monitoring.subtitle": "Bedrock 상태, EC2 현황, 활성 세션, 리소스 사용",
  "monitoring.serviceHealth": "서비스 상태",
  "monitoring.resourceInsights": "리소스 인사이트",
  "monitoring.containerDist": "인스턴스 분포",
  "monitoring.osDist": "OS 분포",
  "monitoring.tierDist": "리소스 Tier 분포",
  "monitoring.activeSessions": "활성 세션",
  "monitoring.servicesHealthy": "서비스 정상",
  "monitoring.containersRunning": "인스턴스 실행 중",
  "monitoring.running": "실행 중",
  "monitoring.pending": "시작 중",
  "monitoring.totalVcpu": "총 vCPU",
  "monitoring.totalMemory": "총 Memory",
  "monitoring.allContainers": "전체 인스턴스",
  "monitoring.allocatedCpu": "할당 CPU",
  "monitoring.allocatedRam": "할당 RAM",
  "monitoring.allStates": "전체 상태",
  "monitoring.modelsConfigured": "모델 설정됨",

  // Users
  "users.title": "사용자 관리",
  "users.subtitle": "Cognito 사용자 CRUD, API 키 관리",
  "users.totalUsers": "전체 사용자",
  "users.active": "활성",
  "users.withApiKey": "환경 보유",
  "users.withEnv": "환경 보유",
  "users.canUseCC": "Claude Code 사용 가능",
  "users.osSplit": "OS 분포",
  "users.tierSplit": "Tier 분포",
  "users.securityDist": "Security Policy 분포",
  "users.registered": "등록됨",
  "users.enabled": "활성화",
  "users.createUser": "사용자 생성",

  // Instances (admin)
  "containers.title": "인스턴스 관리",
  "containers.subtitle": "개발환경 인스턴스 시작/중지/관리",
  "containers.running": "실행 중",
  "containers.pending": "시작 중",
  "containers.totalUsers": "전체 사용자",
  "containers.available": "사용 가능",
  "containers.utilization": "사용률",
  "containers.breakdown": "활성 인스턴스 분석",
  "containers.byOs": "OS별",
  "containers.byTier": "Tier별",
  "containers.startContainer": "인스턴스 시작",
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

  // Request Analysis
  "requestAnalysis.title": "요청 분석",
  "requestAnalysis.successRate": "요청 성공률",
  "requestAnalysis.successLabel": "성공률",
  "requestAnalysis.callTypes": "호출 유형 분포",
  "requestAnalysis.typesLabel": "유형",
  "requestAnalysis.tokenRatio": "토큰 Input/Output 비율",

  // Hourly Activity
  "hourlyActivity.title": "시간대별 활동 패턴",
  "hourlyActivity.distribution": "시간대별 요청 분포",
  "hourlyActivity.peakHour": "피크 시간",
  "hourlyActivity.requests": "요청",
  "hourlyActivity.avgPerHour": "시간당 평균",
  "hourlyActivity.requestsPerHour": "요청/시간",
  "hourlyActivity.activeHours": "활성 시간대",
  "hourlyActivity.hours": "시간",

  // Tool Acceptance
  "toolAcceptance.title": "도구 수락률 & 개발자 참여도",
  "toolAcceptance.overallRate": "전체 수락률",
  "toolAcceptance.overallRateDesc": "성공 요청 비율",
  "toolAcceptance.avgSessionDepth": "평균 세션 깊이",
  "toolAcceptance.avgSessionDepthDesc": "세션당 평균 API 호출",
  "toolAcceptance.totalSessions": "총 세션 수",
  "toolAcceptance.totalSessionsDesc": "사용자별 일별 세션",
  "toolAcceptance.activeDevs": "활성 개발자",
  "toolAcceptance.activeDevsDesc": "기간 내 사용자",
  "toolAcceptance.perUser": "사용자별 참여도 상세",
  "toolAcceptance.user": "사용자",
  "toolAcceptance.sessions": "세션",
  "toolAcceptance.totalReqs": "총 요청",
  "toolAcceptance.sessionDepth": "세션 깊이",
  "toolAcceptance.tokensPerSession": "세션당 토큰",
  "toolAcceptance.acceptRate": "수락률",

  // Home
  "home.title": "CC-on-Bedrock",
  "home.subtitle": "AWS Bedrock 기반 멀티유저 Claude Code 개발환경",
  "home.totalCost": "총 비용",
  "home.totalRequests": "총 요청",
  "home.activeUsers": "활성 사용자",
  "home.runningContainers": "실행 인스턴스",
  "home.bedrockStatus": "Bedrock 상태",
  "home.usageTracking": "사용량 추적",
  "home.architecture": "아키텍처",
  "home.modelCount": "활성 모델",
  "home.quickActions": "빠른 작업",
  "home.viewAnalytics": "분석 대시보드",
  "home.viewMonitoring": "모니터링",
  "home.manageUsers": "사용자 관리",
  "home.manageContainers": "인스턴스 관리",
  "home.totalTokens": "총 토큰",
  "home.costTrend": "비용 트렌드",
  "home.modelUsage": "모델 사용량",
  "home.activeContainers": "실행 인스턴스",
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
  "nav.myEnv": "My Environment",
  "nav.department": "Department",
  "nav.ai": "AI Assistant",
  "nav.analytics": "Analytics",
  "nav.security": "Security",
  "nav.monitoring": "Monitoring",
  "nav.users": "Users",
  "nav.containers": "Instances",
  "nav.tokens": "Token Usage",
  "nav.budgets": "Budget Settings",
  "nav.approvals": "Approvals",
  "nav.dlpManagement": "DLP Management",
  "nav.docs": "Guide",
  "nav.signout": "Sign out",
  "nav.admin": "Admin",
  "nav.user": "User",

  // User Portal
  "user.containerStatus": "Instance Status",
  "user.os": "Operating System",
  "user.tier": "Resource Tier",
  "user.subdomain": "Subdomain",
  "user.start": "Start Instance",
  "user.stop": "Stop Instance",
  "user.selectTier": "Select Resource Tier",
  "user.starting": "Starting...",
  "user.stopping": "Stopping...",
  "user.stopped": "Stopped",
  "user.openCodeServer": "Open code-server",
  "user.dailyUsage": "Today's Usage",
  "user.tokenUsage": "Token Usage",
  "user.ofDailyLimit": "of daily limit",
  "user.requests": "API Requests",
  "user.estimatedCost": "Est. Cost",
  "user.workspaceInfo": "Workspace Info",
  "user.securityPolicy": "Security Policy",
  "user.policyOpen": "Full network access",
  "user.policyRestricted": "Restricted external access",
  "user.policyLocked": "No external network",
  "user.accessUrl": "Access URL",
  "user.noSubdomain": "No subdomain assigned",

  // Department Dashboard
  "dept.budgetOverview": "Monthly Budget",
  "dept.costUsage": "Cost Usage",
  "dept.tokenUsage": "Token Usage",
  "dept.monthlyTrend": "Monthly Spend Trend",
  "dept.pendingApprovals": "Pending Approval Requests",
  "dept.members": "Department Members",
  "dept.approve": "Approve",
  "dept.reject": "Reject",
  "dept.allDepartments": "All Departments",
  "dept.overview": "Department Overview",
  "dept.budgetUtil": "Budget Utilization",
  "dept.activeContainers": "Active Instances",
  "dept.pendingCount": "Pending Approvals",
  "dept.totalMembers": "Total Members",
  "dept.totalCost": "Total Cost",
  "dept.totalTokens": "Total Tokens",

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
  "overview.deptCount": "Departments",

  // Department Analysis
  "dept.title": "Department Analysis",
  "dept.filterLabel": "Department",
  "dept.totalDepts": "Total Departments",
  "dept.totalDeptsDesc": "Active departments",
  "dept.topByCost": "Top Dept by Cost",
  "dept.topByTokens": "Top Dept by Tokens",
  "dept.topByUsers": "Dept with Most Users",
  "dept.users": "users",
  "dept.costByDept": "Cost by Department (USD)",
  "dept.requestsByDept": "Requests by Department",
  "dept.tokenDistribution": "Token Distribution by Department",
  "dept.totalTokensLabel": "Total Tokens",

  // User x Department Insights
  "userDept.title": "User x Department Insights",
  "userDept.tableTitle": "Per-User Department / Model / Token / Cost Details",
  "userDept.user": "User",
  "userDept.department": "Department",
  "userDept.modelsUsed": "Models Used",
  "userDept.requests": "Requests",
  "userDept.inputTokens": "Input Tokens",
  "userDept.outputTokens": "Output Tokens",
  "userDept.totalCost": "Total Cost",
  "userDept.avgTokensPerReq": "Avg Tokens/Req",

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
  "system.bedrockStatus": "Bedrock API",
  "system.database": "Usage Tracking (DynamoDB)",
  "system.architecture": "Architecture",
  "system.version": "Direct Bedrock",

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
  "modelPerf.usageDistribution": "Model Usage Distribution",
  "modelPerf.totalRequests": "Total Requests",
  "modelPerf.summaryTable": "Model Request/Token/Cost Summary",

  // Monitoring
  "monitoring.title": "Operations Monitoring",
  "monitoring.subtitle": "Bedrock health, EC2 status, active sessions, resource usage",
  "monitoring.serviceHealth": "Service Health",
  "monitoring.resourceInsights": "Resource Insights",
  "monitoring.containerDist": "Instance Distribution",
  "monitoring.osDist": "OS Distribution",
  "monitoring.tierDist": "Resource Tier Distribution",
  "monitoring.activeSessions": "Active Sessions",
  "monitoring.servicesHealthy": "Services Healthy",
  "monitoring.containersRunning": "instances running",
  "monitoring.running": "Running",
  "monitoring.pending": "Pending",
  "monitoring.totalVcpu": "Total vCPU",
  "monitoring.totalMemory": "Total Memory",
  "monitoring.allContainers": "All Instances",
  "monitoring.allocatedCpu": "Allocated CPU",
  "monitoring.allocatedRam": "Allocated RAM",
  "monitoring.allStates": "All states",
  "monitoring.modelsConfigured": "models configured",

  // Users
  "users.title": "User Management",
  "users.subtitle": "Cognito user CRUD, API key management",
  "users.totalUsers": "Total Users",
  "users.active": "Active",
  "users.withApiKey": "With Environment",
  "users.withEnv": "With Environment",
  "users.canUseCC": "Can use Claude Code",
  "users.osSplit": "OS Split",
  "users.tierSplit": "Tier Split",
  "users.securityDist": "Security Policy Distribution",
  "users.registered": "Registered",
  "users.enabled": "enabled",
  "users.createUser": "Create User",

  // Containers
  "containers.title": "Instance Management",
  "containers.subtitle": "Start, stop, and manage dev environment instances",
  "containers.running": "Running",
  "containers.pending": "Pending",
  "containers.totalUsers": "Total Users",
  "containers.available": "Available",
  "containers.utilization": "Utilization",
  "containers.breakdown": "Active Instance Breakdown",
  "containers.byOs": "By OS",
  "containers.byTier": "By Tier",
  "containers.startContainer": "Start Instance",
  "containers.cancel": "Cancel",

  // User Model Insights
  "userModel.title": "User x Model Usage Insights",
  "userModel.matrix": "User x Model Matrix",
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

  // Request Analysis
  "requestAnalysis.title": "Request Analysis",
  "requestAnalysis.successRate": "Request Success Rate",
  "requestAnalysis.successLabel": "Success",
  "requestAnalysis.callTypes": "Call Type Distribution",
  "requestAnalysis.typesLabel": "Types",
  "requestAnalysis.tokenRatio": "Token Input/Output Ratio",

  // Hourly Activity
  "hourlyActivity.title": "Hourly Activity Patterns",
  "hourlyActivity.distribution": "Request Distribution by Hour",
  "hourlyActivity.peakHour": "Peak Hour",
  "hourlyActivity.requests": "requests",
  "hourlyActivity.avgPerHour": "Avg per Hour",
  "hourlyActivity.requestsPerHour": "requests/hour",
  "hourlyActivity.activeHours": "Active Hours",
  "hourlyActivity.hours": "hours",

  // Tool Acceptance
  "toolAcceptance.title": "Tool Acceptance & Developer Engagement",
  "toolAcceptance.overallRate": "Overall Acceptance Rate",
  "toolAcceptance.overallRateDesc": "Successful request ratio",
  "toolAcceptance.avgSessionDepth": "Avg Session Depth",
  "toolAcceptance.avgSessionDepthDesc": "Avg API calls per session",
  "toolAcceptance.totalSessions": "Total Sessions",
  "toolAcceptance.totalSessionsDesc": "User x day sessions",
  "toolAcceptance.activeDevs": "Active Developers",
  "toolAcceptance.activeDevsDesc": "Users in period",
  "toolAcceptance.perUser": "Per-User Engagement Details",
  "toolAcceptance.user": "User",
  "toolAcceptance.sessions": "Sessions",
  "toolAcceptance.totalReqs": "Total Reqs",
  "toolAcceptance.sessionDepth": "Session Depth",
  "toolAcceptance.tokensPerSession": "Tokens/Session",
  "toolAcceptance.acceptRate": "Accept Rate",

  // Home
  "home.title": "CC-on-Bedrock",
  "home.subtitle": "Multi-user Claude Code Dev Environment on AWS Bedrock",
  "home.totalCost": "Total Cost",
  "home.totalRequests": "Total Requests",
  "home.activeUsers": "Active Users",
  "home.runningContainers": "Running Instances",
  "home.bedrockStatus": "Bedrock Status",
  "home.usageTracking": "Usage Tracking",
  "home.architecture": "Architecture",
  "home.modelCount": "Active Models",
  "home.quickActions": "Quick Actions",
  "home.viewAnalytics": "Analytics Dashboard",
  "home.viewMonitoring": "Monitoring",
  "home.manageUsers": "User Management",
  "home.manageContainers": "Instance Management",
  "home.totalTokens": "Total Tokens",
  "home.costTrend": "Cost Trend",
  "home.modelUsage": "Model Usage",
  "home.activeContainers": "Running Instances",
  "home.recentActivity": "Recent Activity",

  // Common
  "common.refresh": "Refresh",
  "common.active": "Active",
  "common.startingUp": "Starting up",
  "common.registered": "Registered",
  "common.canStart": "Can start",
};
