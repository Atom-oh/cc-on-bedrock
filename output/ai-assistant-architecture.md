> **Language / 언어**: [한국어](#ko) | [English](#en)

---

<a id="ko"></a>

# CC-on-Bedrock AI Assistant 아키텍처

<a id="ko-overview"></a>
## 개요

CC-on-Bedrock AI Assistant는 **Bedrock Converse API** + **Tool Use** + **AgentCore Memory**를 결합한 대화형 플랫폼 운영 도우미입니다. 관리자가 자연어로 플랫폼 상태를 질문하면 실시간 데이터를 조회하여 응답합니다.

---

<a id="ko-overall-architecture"></a>
## 1. 전체 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (AI Assistant 페이지)                                    │
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ 텍스트 입력  │  │  음성 입력    │  │  대화 히스토리 (Memory)  │  │
│  │ (textarea)  │  │ (Web Speech  │  │  AgentCore에서 불러옴    │  │
│  │             │  │  STT API)    │  │                          │  │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────────────┘  │
│         │                │                                        │
│         └────────┬───────┘                                        │
│                  ▼                                                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  POST /api/ai                                            │    │
│  │  (Server-Sent Events 스트리밍)                             │    │
│  └──────────────────────────┬───────────────────────────────┘    │
│                              │                                    │
└──────────────────────────────┼────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Next.js API Route (/api/ai/route.ts)                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Bedrock Converse API (ConverseStreamCommand)              │  │
│  │  Model: claude-sonnet-4-6 (global)                         │  │
│  │                                                            │  │
│  │  System Prompt + 사용자 메시지 + Tool Config                │  │
│  │           │                                                │  │
│  │           ▼                                                │  │
│  │  ┌─────────────────────────────────────────────┐           │  │
│  │  │  Claude Sonnet 4.6 응답                      │           │  │
│  │  │                                             │           │  │
│  │  │  텍스트 응답   or   Tool Use 요청            │           │  │
│  │  │  (스트리밍)         (tool_use stop reason)   │           │  │
│  │  └────────┬──────────────────┬──────────────────┘           │  │
│  │           │                  │                              │  │
│  │           │            ┌─────▼──────────────┐               │  │
│  │           │            │  Tool 실행          │               │  │
│  │           │            │  → ECS API 호출     │               │  │
│  │           │            │  → CloudWatch 조회  │               │  │
│  │           │            │  → 결과를 메시지에   │               │  │
│  │           │            │    추가하고 재호출   │               │  │
│  │           │            └─────┬──────────────┘               │  │
│  │           │                  │                              │  │
│  │           │            (최대 5회 반복)                       │  │
│  │           │                  │                              │  │
│  │           ▼                  ▼                              │  │
│  │  ┌─────────────────────────────────────────────┐           │  │
│  │  │  최종 텍스트 응답 (스트리밍 → Browser)        │           │  │
│  │  └─────────────────────────────────────────────┘           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  AgentCore Memory (/api/ai/memory)                         │  │
│  │  응답 완료 후 → Q&A를 Memory에 저장 (비동기)                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

<a id="ko-converse-api"></a>
## 2. Bedrock Converse API 흐름

### 2.1 요청-응답 사이클

```
┌──────────┐                    ┌──────────────┐                ┌───────────┐
│  Browser  │                    │  Next.js API │                │  Bedrock  │
│           │                    │  /api/ai     │                │  Sonnet   │
└─────┬─────┘                    └──────┬───────┘                └─────┬─────┘
      │                                 │                              │
      │ POST /api/ai                    │                              │
      │ {messages, lang}                │                              │
      ├────────────────────────────────>│                              │
      │                                 │                              │
      │                                 │ ConverseStreamCommand        │
      │                                 │ {modelId, system, messages,  │
      │                                 │  toolConfig, inferenceConfig}│
      │                                 ├─────────────────────────────>│
      │                                 │                              │
      │  SSE: data: {"status":"..."}    │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: contentBlockDelta   │
      │                                 │  (텍스트 조각)               │
      │                                 │<─────────────────────────────│
      │  SSE: data: {"text":"안녕"}     │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: contentBlockStart   │
      │                                 │  (toolUse: get_container_    │
      │                                 │   status)                    │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │  SSE: data: {"status":          │                              │
      │    "tool: get_container_status"} │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: messageStop         │
      │                                 │  (stopReason: "tool_use")    │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │                                 │── Tool 실행 ──               │
      │                                 │ listContainers() → ECS API  │
      │                                 │                              │
      │                                 │ 결과를 toolResult로 추가     │
      │                                 │ → 2차 ConverseStream 호출    │
      │                                 ├─────────────────────────────>│
      │                                 │                              │
      │                                 │  Stream: 최종 텍스트 응답    │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │  SSE: data: {"text":"현재 6개   │                              │
      │    컨테이너가 실행 중..."}       │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │  SSE: data: {"done":true,       │                              │
      │    "via":"Bedrock Converse"}     │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
```

### 2.2 System Prompt

```
You are CC-on-Bedrock AI Assistant. You manage a multi-user Claude Code
platform on AWS Bedrock.

Architecture: Users run Claude Code in ECS containers with direct Bedrock
access via Task Roles. No proxy.

Use tools to get current data before answering.
Respond in Korean. (또는 English)
Use markdown tables for comparisons. Format numbers clearly.
```

### 2.3 모델 설정

| 항목 | 값 |
|------|-----|
| **Model ID** | `global.anthropic.claude-sonnet-4-6` |
| **Max Tokens** | 4,096 |
| **Streaming** | ConverseStreamCommand (SSE) |
| **Tool Use** | 최대 5회 반복 (tool_use → 실행 → 재호출) |
| **Context Window** | 최근 8개 메시지만 전송 (비용 제어) |

---

<a id="ko-tool-use"></a>
## 3. Tool Use (함수 호출)

### 3.1 등록된 Tools

| Tool 이름 | 설명 | 데이터 소스 |
|-----------|------|------------|
| `get_container_status` | ECS 컨테이너 상태, 사용자 할당, OS/Tier 분포 | ECS `ListTasks` + `DescribeTasks` API |
| `get_container_metrics` | CloudWatch CPU/Memory/Network 클러스터 메트릭 | CloudWatch `GetMetricData` API |
| `get_platform_summary` | 아키텍처, 컨테이너 상태, 클러스터 헬스 종합 | ECS + CloudWatch 조합 |

### 3.2 Tool 실행 흐름

```
Claude가 "현재 컨테이너 상태를 알려줘" 요청을 받으면:

1. Claude 판단: get_container_status Tool 호출 필요
   └─ stopReason: "tool_use"
   └─ toolUse: { name: "get_container_status", toolUseId: "abc123" }

2. Next.js가 Tool 실행:
   └─ executeTool("get_container_status")
   └─ ECS listContainers() 호출
   └─ 결과 JSON 생성:
      {
        "total": 8,
        "running": 6,
        "osDist": { "ubuntu": 4, "al2023": 2 },
        "tierDist": { "standard": 3, "power": 2, "light": 1 },
        "containers": [
          { "user": "admin01", "status": "RUNNING", "os": "ubuntu", "tier": "power", ... },
          ...
        ]
      }

3. 결과를 toolResult 메시지로 추가:
   messages.push({
     role: "user",
     content: [{ toolResult: { toolUseId: "abc123", content: [{ text: JSON결과 }] } }]
   })

4. Bedrock에 2차 ConverseStream 호출
   └─ Claude가 Tool 결과를 자연어로 정리하여 응답
```

### 3.3 Multi-Tool 호출

Claude는 한 번의 응답에서 **여러 Tool을 동시에 요청**할 수 있습니다:

```
사용자: "컨테이너 상태와 CPU 사용률을 같이 보여줘"

Claude 응답 (iteration 1):
  ├─ toolUse: get_container_status  (id: "abc")
  └─ toolUse: get_container_metrics (id: "def")

Next.js 실행:
  ├─ executeTool("get_container_status")  → 컨테이너 정보
  └─ executeTool("get_container_metrics") → CPU/Memory 메트릭

2차 호출: 두 결과를 모두 toolResult로 포함
  → Claude가 통합하여 최종 응답 생성
```

### 3.4 Tool 반복 제한

```
최대 반복: 5회 (for loop iteration < 5)

일반적 패턴:
  Iteration 0: 사용자 질문 → Claude가 Tool 호출 결정 (tool_use)
  Iteration 1: Tool 결과 제공 → Claude가 최종 응답 (end_turn)
  → 총 2회로 완료

복잡한 질문:
  Iteration 0: Tool A 호출
  Iteration 1: Tool A 결과 → Tool B 추가 호출
  Iteration 2: Tool B 결과 → 최종 응답
  → 총 3회

5회 초과 시: 강제 중단 (무한 루프 방지)
```

---

<a id="ko-sse"></a>
## 4. Server-Sent Events (SSE) 스트리밍

### 4.1 SSE 프로토콜

```
Response Headers:
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

Event 형식:
  data: {"key": "value"}\n\n
```

### 4.2 SSE 이벤트 타입

| 이벤트 | 형식 | 설명 |
|--------|------|------|
| **status** | `{"status": "Analyzing..."}` | 진행 상태 표시 (로딩, Tool 실행 중) |
| **text** | `{"text": "응답 조각"}` | 텍스트 스트리밍 (글자 단위) |
| **usage** | `{"usage": {"inputTokens": 500, "outputTokens": 200}}` | 토큰 사용량 |
| **done** | `{"done": true, "via": "Bedrock Converse"}` | 응답 완료 |

### 4.3 클라이언트 처리 (ai-assistant.tsx)

```typescript
// SSE 스트림 읽기
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));

    if (data.text)   → 실시간 텍스트 표시 (타이핑 효과)
    if (data.status) → 상태 표시 ("tool: get_container_status")
    if (data.usage)  → 토큰 수 기록
    if (data.done)   → 완료 처리, Memory에 저장
  }
}
```

---

<a id="ko-agentcore-memory"></a>
## 5. AgentCore Memory (대화 기억)

### 5.1 Memory 구조

```
┌──────────────────────────────────────────────────────────┐
│  Amazon Bedrock AgentCore Memory                         │
│                                                          │
│  Memory ID: cconbedrock_memory-pHqYq73dKd                │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Session: session_admin01_whchoi_net               │  │
│  │  Actor:   admin01_whchoi_net                       │  │
│  │                                                    │  │
│  │  Event 1: 2026-03-24T10:00:00Z                    │  │
│  │  ├─ USER: "현재 컨테이너 상태를 알려줘"             │  │
│  │  └─ ASSISTANT: "현재 6개의 컨테이너가..."           │  │
│  │     [tools:get_container_status]                   │  │
│  │     [in:1200][out:800][time:2500]                  │  │
│  │                                                    │  │
│  │  Event 2: 2026-03-24T10:05:00Z                    │  │
│  │  ├─ USER: "CPU 사용률은?"                           │  │
│  │  └─ ASSISTANT: "클러스터 CPU 사용률은 45.2%..."     │  │
│  │     [tools:get_container_metrics]                  │  │
│  │     [in:1500][out:600][time:1800]                  │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Session: session_ds-01_whchoi_net                 │  │
│  │  (다른 사용자의 대화 기록)                           │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Memory 저장 흐름

```
[AI 응답 완료]
      │
      ▼
POST /api/ai/memory
{
  question: "현재 컨테이너 상태를 알려줘",
  answer: "현재 6개의 컨테이너가 실행 중입니다...",
  tools: ["get_container_status"],
  inputTokens: 1200,
  outputTokens: 800,
  responseTime: 2500
}
      │
      ▼
AgentCore CreateEventCommand
{
  memoryId: "cconbedrock_memory-pHqYq73dKd",
  sessionId: "session_admin01_whchoi_net",
  actorId: "admin01_whchoi_net",
  payload: [
    { conversational: { role: "USER", content: { text: "질문" } } },
    { conversational: { role: "ASSISTANT", content: { text: "응답\n\n---\n[메타데이터]" } } }
  ]
}
```

### 5.3 Memory 조회 (히스토리)

```
GET /api/ai/memory?limit=20
      │
      ▼
AgentCore ListEventsCommand
{
  memoryId: "cconbedrock_memory-pHqYq73dKd",
  sessionId: "session_admin01_whchoi_net",
  actorId: "admin01_whchoi_net",
  includePayloads: true,
  pageSize: 20
}
      │
      ▼
응답 파싱:
  - payload에서 USER/ASSISTANT 텍스트 추출
  - ASSISTANT 텍스트에서 메타데이터 파싱:
    [tools:get_container_status]  → 사용된 도구
    [in:1200]                     → Input 토큰
    [out:800]                     → Output 토큰
    [time:2500]                   → 응답 시간 (ms)
      │
      ▼
Dashboard "대화 히스토리" 섹션에 표시
```

### 5.4 사용자별 격리

| 항목 | 값 | 설명 |
|------|-----|------|
| **Memory ID** | 전체 공유 | 하나의 AgentCore Memory 인스턴스 |
| **Session ID** | `session_{sanitized_email}` | 사용자 이메일 기반 세션 분리 |
| **Actor ID** | `{sanitized_email}` | 사용자 식별 |
| **격리 수준** | 세션 레벨 | 다른 사용자의 대화는 조회 불가 |

---

<a id="ko-voice-input"></a>
## 6. 음성 입력 (Web Speech API)

### 6.1 STT (Speech-to-Text) 흐름

```
┌──────────┐                    ┌─────────────────┐
│  Browser  │                    │  Web Speech API  │
│  (React)  │                    │  (브라우저 내장)  │
└─────┬─────┘                    └────────┬────────┘
      │                                   │
      │ 마이크 버튼 클릭                    │
      ├──────────────────────────────────>│
      │                                   │
      │               음성 인식 시작        │
      │               (한국어 또는 영어)    │
      │                                   │
      │ onresult: 인식된 텍스트             │
      │<──────────────────────────────────│
      │                                   │
      │ 자동으로 sendMessage() 호출         │
      │ (인식 완료 시)                      │
      │                                   │
```

### 6.2 지원 언어

| 설정 | 언어 코드 | 동작 |
|------|----------|------|
| 한국어 모드 | `ko-KR` | 한국어 음성 인식 → 한국어 응답 |
| 영어 모드 | `en-US` | 영어 음성 인식 → 영어 응답 |

---

<a id="ko-rendering"></a>
## 7. 응답 렌더링

### 7.1 Markdown 렌더링

```
Claude 응답 (raw):
  ## 컨테이너 상태
  | 사용자 | OS | Tier | 상태 |
  |--------|-----|------|------|
  | admin01 | Ubuntu | Power | RUNNING |

  → react-markdown + remark-gfm으로 렌더링
  → 테이블, 코드 블록, 헤더 등 지원
```

### 7.2 응답 메타데이터 표시

```
┌──────────────────────────────────────────────────────┐
│  (AI 응답 Markdown 내용)                              │
│                                                      │
│  현재 6개의 컨테이너가 실행 중입니다...                 │
│  | 사용자 | OS | Tier | 상태 |                        │
│  |--------|-----|------|------|                       │
│  | admin01 | Ubuntu | Power | RUNNING |              │
│                                                      │
│──────────────────────────────────────────────────────│
│  get_container_status                                │
│  In: 1,200 · Out: 800 tokens                        │
│  2.5s                                                │
│  via Bedrock Converse + Tool Use (Direct)    Copy    │
└──────────────────────────────────────────────────────┘
```

### 7.3 복사 기능

```
"복사" 버튼 클릭
  → navigator.clipboard.writeText(msg.content)
  → 2초간 "Copied" 표시
  → 원래 "Copy" 아이콘으로 복귀
```

---

<a id="ko-error-handling"></a>
## 8. 에러 처리

| 상황 | 처리 |
|------|------|
| Bedrock API 에러 | SSE로 에러 메시지 전송 → UI에 표시 |
| Tool 실행 실패 | `{"error": "..."}` JSON 반환 → Claude가 에러 안내 |
| 5회 반복 초과 | 루프 종료, 마지막 응답 반환 |
| SSE 연결 끊김 | `controllerClosed` 플래그로 이중 쓰기 방지 |
| Memory 저장 실패 | 무시 (catch → 빈 처리, 대화는 정상 완료) |
| 인증 실패 | 403 Forbidden (admin 그룹만 접근) |

---

<a id="ko-performance"></a>
## 9. 성능 특성

| 항목 | 값 | 비고 |
|------|-----|------|
| **모델** | Sonnet 4.6 | Opus 대비 비용 1/5, 속도 2~3배 |
| **첫 토큰 지연** | ~1초 | SSE 스트리밍으로 체감 속도 향상 |
| **평균 응답 시간** | 2~5초 | Tool 사용 시 추가 1~2초 |
| **컨텍스트 제한** | 최근 8메시지 | 토큰 비용 제어 |
| **Memory 저장** | 비동기 | 응답 완료 후 백그라운드 |
| **접근 제어** | admin 전용 | 일반 user는 403 |

---

<a id="ko-file-structure"></a>
## 10. 관련 파일 구조

```
shared/nextjs-app/src/
├── app/
│   ├── ai/
│   │   └── ai-assistant.tsx       ← 프론트엔드 (React, SSE 클라이언트, 음성 입력)
│   └── api/
│       └── ai/
│           ├── route.ts           ← Bedrock Converse API + Tool Use 핸들러
│           └── memory/
│               └── route.ts       ← AgentCore Memory CRUD (GET/POST)
├── lib/
│   ├── aws-clients.ts             ← listContainers() (ECS SDK)
│   └── cloudwatch-client.ts       ← getContainerMetrics() (CloudWatch SDK)
└── components/
    └── markdown-text.tsx          ← react-markdown 렌더러 (remark-gfm)
```

---

<a id="ko-agentcore-resources"></a>
## 11. AgentCore 리소스 정보

| 리소스 | ID/ARN | 용도 |
|--------|--------|------|
| **AgentCore Runtime** | `cconbedrock_agent-xcceE4DydC` | AgentCore 에이전트 (ECR 기반) |
| **AgentCore Memory** | `cconbedrock_memory-pHqYq73dKd` | 대화 기억 저장소 |
| **ECR Repository** | `cc-on-bedrock/agent` | AgentCore 에이전트 Docker 이미지 |
| **IAM Role** | `AWSopsAgentCoreRole` | AgentCore 서비스 실행 권한 |

---

<a id="en"></a>

# CC-on-Bedrock AI Assistant Architecture

<a id="en-overview"></a>
## Overview

The CC-on-Bedrock AI Assistant is a conversational platform operations assistant that combines **Bedrock Converse API** + **Tool Use** + **AgentCore Memory**. When administrators ask platform status questions in natural language, it queries real-time data to respond.

---

<a id="en-overall-architecture"></a>
## 1. Overall Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (AI Assistant Page)                                      │
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Text Input  │  │  Voice Input  │  │  Chat History (Memory)   │  │
│  │ (textarea)  │  │ (Web Speech  │  │  Loaded from AgentCore   │  │
│  │             │  │  STT API)    │  │                          │  │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────────────┘  │
│         │                │                                        │
│         └────────┬───────┘                                        │
│                  ▼                                                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  POST /api/ai                                            │    │
│  │  (Server-Sent Events streaming)                           │    │
│  └──────────────────────────┬───────────────────────────────┘    │
│                              │                                    │
└──────────────────────────────┼────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Next.js API Route (/api/ai/route.ts)                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Bedrock Converse API (ConverseStreamCommand)              │  │
│  │  Model: claude-sonnet-4-6 (global)                         │  │
│  │                                                            │  │
│  │  System Prompt + User Message + Tool Config                │  │
│  │           │                                                │  │
│  │           ▼                                                │  │
│  │  ┌─────────────────────────────────────────────┐           │  │
│  │  │  Claude Sonnet 4.6 Response                  │           │  │
│  │  │                                             │           │  │
│  │  │  Text Response  or  Tool Use Request         │           │  │
│  │  │  (streaming)        (tool_use stop reason)   │           │  │
│  │  └────────┬──────────────────┬──────────────────┘           │  │
│  │           │                  │                              │  │
│  │           │            ┌─────▼──────────────┐               │  │
│  │           │            │  Tool Execution     │               │  │
│  │           │            │  → ECS API call     │               │  │
│  │           │            │  → CloudWatch query │               │  │
│  │           │            │  → Add result to    │               │  │
│  │           │            │    messages & retry  │               │  │
│  │           │            └─────┬──────────────┘               │  │
│  │           │                  │                              │  │
│  │           │            (max 5 iterations)                   │  │
│  │           │                  │                              │  │
│  │           ▼                  ▼                              │  │
│  │  ┌─────────────────────────────────────────────┐           │  │
│  │  │  Final Text Response (streaming → Browser)   │           │  │
│  │  └─────────────────────────────────────────────┘           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  AgentCore Memory (/api/ai/memory)                         │  │
│  │  After response → Save Q&A to Memory (async)               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

<a id="en-converse-api"></a>
## 2. Bedrock Converse API Flow

### 2.1 Request-Response Cycle

```
┌──────────┐                    ┌──────────────┐                ┌───────────┐
│  Browser  │                    │  Next.js API │                │  Bedrock  │
│           │                    │  /api/ai     │                │  Sonnet   │
└─────┬─────┘                    └──────┬───────┘                └─────┬─────┘
      │                                 │                              │
      │ POST /api/ai                    │                              │
      │ {messages, lang}                │                              │
      ├────────────────────────────────>│                              │
      │                                 │                              │
      │                                 │ ConverseStreamCommand        │
      │                                 │ {modelId, system, messages,  │
      │                                 │  toolConfig, inferenceConfig}│
      │                                 ├─────────────────────────────>│
      │                                 │                              │
      │  SSE: data: {"status":"..."}    │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: contentBlockDelta   │
      │                                 │  (text fragment)             │
      │                                 │<─────────────────────────────│
      │  SSE: data: {"text":"Hello"}    │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: contentBlockStart   │
      │                                 │  (toolUse: get_container_    │
      │                                 │   status)                    │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │  SSE: data: {"status":          │                              │
      │    "tool: get_container_status"} │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │                                 │  Stream: messageStop         │
      │                                 │  (stopReason: "tool_use")    │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │                                 │── Tool Execution ──          │
      │                                 │ listContainers() → ECS API  │
      │                                 │                              │
      │                                 │ Add result as toolResult     │
      │                                 │ → 2nd ConverseStream call    │
      │                                 ├─────────────────────────────>│
      │                                 │                              │
      │                                 │  Stream: final text response │
      │                                 │<─────────────────────────────│
      │                                 │                              │
      │  SSE: data: {"text":"Currently  │                              │
      │    6 containers running..."}    │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
      │  SSE: data: {"done":true,       │                              │
      │    "via":"Bedrock Converse"}     │                              │
      │<────────────────────────────────│                              │
      │                                 │                              │
```

### 2.2 System Prompt

```
You are CC-on-Bedrock AI Assistant. You manage a multi-user Claude Code
platform on AWS Bedrock.

Architecture: Users run Claude Code in ECS containers with direct Bedrock
access via Task Roles. No proxy.

Use tools to get current data before answering.
Respond in Korean. (or English)
Use markdown tables for comparisons. Format numbers clearly.
```

### 2.3 Model Configuration

| Setting | Value |
|---------|-------|
| **Model ID** | `global.anthropic.claude-sonnet-4-6` |
| **Max Tokens** | 4,096 |
| **Streaming** | ConverseStreamCommand (SSE) |
| **Tool Use** | Max 5 iterations (tool_use → execute → re-invoke) |
| **Context Window** | Only last 8 messages sent (cost control) |

---

<a id="en-tool-use"></a>
## 3. Tool Use (Function Calling)

### 3.1 Registered Tools

| Tool Name | Description | Data Source |
|-----------|-------------|------------|
| `get_container_status` | ECS container status, user allocation, OS/Tier distribution | ECS `ListTasks` + `DescribeTasks` API |
| `get_container_metrics` | CloudWatch CPU/Memory/Network cluster metrics | CloudWatch `GetMetricData` API |
| `get_platform_summary` | Architecture, container status, cluster health overview | ECS + CloudWatch combined |

### 3.2 Tool Execution Flow

```
When Claude receives "Tell me the current container status":

1. Claude decides: Need to call get_container_status Tool
   └─ stopReason: "tool_use"
   └─ toolUse: { name: "get_container_status", toolUseId: "abc123" }

2. Next.js executes the Tool:
   └─ executeTool("get_container_status")
   └─ Calls ECS listContainers()
   └─ Generates result JSON:
      {
        "total": 8,
        "running": 6,
        "osDist": { "ubuntu": 4, "al2023": 2 },
        "tierDist": { "standard": 3, "power": 2, "light": 1 },
        "containers": [
          { "user": "admin01", "status": "RUNNING", "os": "ubuntu", "tier": "power", ... },
          ...
        ]
      }

3. Add result as toolResult message:
   messages.push({
     role: "user",
     content: [{ toolResult: { toolUseId: "abc123", content: [{ text: JSONresult }] } }]
   })

4. 2nd ConverseStream call to Bedrock
   └─ Claude organizes Tool results into natural language response
```

### 3.3 Multi-Tool Invocation

Claude can **request multiple Tools simultaneously** in a single response:

```
User: "Show me container status and CPU usage together"

Claude response (iteration 1):
  ├─ toolUse: get_container_status  (id: "abc")
  └─ toolUse: get_container_metrics (id: "def")

Next.js execution:
  ├─ executeTool("get_container_status")  → container info
  └─ executeTool("get_container_metrics") → CPU/Memory metrics

2nd call: Include both results as toolResult
  → Claude integrates and generates final response
```

### 3.4 Tool Iteration Limit

```
Max iterations: 5 (for loop iteration < 5)

Typical pattern:
  Iteration 0: User question → Claude decides Tool call (tool_use)
  Iteration 1: Tool result provided → Claude gives final response (end_turn)
  → Completed in 2 iterations

Complex questions:
  Iteration 0: Call Tool A
  Iteration 1: Tool A result → Additional Tool B call
  Iteration 2: Tool B result → Final response
  → 3 iterations total

Over 5 iterations: Force stop (prevent infinite loops)
```

---

<a id="en-sse"></a>
## 4. Server-Sent Events (SSE) Streaming

### 4.1 SSE Protocol

```
Response Headers:
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

Event format:
  data: {"key": "value"}\n\n
```

### 4.2 SSE Event Types

| Event | Format | Description |
|-------|--------|-------------|
| **status** | `{"status": "Analyzing..."}` | Progress indicator (loading, Tool executing) |
| **text** | `{"text": "response chunk"}` | Text streaming (character-level) |
| **usage** | `{"usage": {"inputTokens": 500, "outputTokens": 200}}` | Token usage |
| **done** | `{"done": true, "via": "Bedrock Converse"}` | Response complete |

### 4.3 Client Handling (ai-assistant.tsx)

```typescript
// Reading SSE stream
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));

    if (data.text)   → Display text in real-time (typing effect)
    if (data.status) → Show status ("tool: get_container_status")
    if (data.usage)  → Record token count
    if (data.done)   → Complete processing, save to Memory
  }
}
```

---

<a id="en-agentcore-memory"></a>
## 5. AgentCore Memory (Conversation Memory)

### 5.1 Memory Structure

```
┌──────────────────────────────────────────────────────────┐
│  Amazon Bedrock AgentCore Memory                         │
│                                                          │
│  Memory ID: cconbedrock_memory-pHqYq73dKd                │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Session: session_admin01_whchoi_net               │  │
│  │  Actor:   admin01_whchoi_net                       │  │
│  │                                                    │  │
│  │  Event 1: 2026-03-24T10:00:00Z                    │  │
│  │  ├─ USER: "Tell me the current container status"   │  │
│  │  └─ ASSISTANT: "Currently 6 containers are..."     │  │
│  │     [tools:get_container_status]                   │  │
│  │     [in:1200][out:800][time:2500]                  │  │
│  │                                                    │  │
│  │  Event 2: 2026-03-24T10:05:00Z                    │  │
│  │  ├─ USER: "What's the CPU usage?"                  │  │
│  │  └─ ASSISTANT: "Cluster CPU usage is 45.2%..."     │  │
│  │     [tools:get_container_metrics]                  │  │
│  │     [in:1500][out:600][time:1800]                  │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Session: session_ds-01_whchoi_net                 │  │
│  │  (Another user's conversation history)              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Memory Save Flow

```
[AI Response Complete]
      │
      ▼
POST /api/ai/memory
{
  question: "Tell me the current container status",
  answer: "Currently 6 containers are running...",
  tools: ["get_container_status"],
  inputTokens: 1200,
  outputTokens: 800,
  responseTime: 2500
}
      │
      ▼
AgentCore CreateEventCommand
{
  memoryId: "cconbedrock_memory-pHqYq73dKd",
  sessionId: "session_admin01_whchoi_net",
  actorId: "admin01_whchoi_net",
  payload: [
    { conversational: { role: "USER", content: { text: "question" } } },
    { conversational: { role: "ASSISTANT", content: { text: "response\n\n---\n[metadata]" } } }
  ]
}
```

### 5.3 Memory Query (History)

```
GET /api/ai/memory?limit=20
      │
      ▼
AgentCore ListEventsCommand
{
  memoryId: "cconbedrock_memory-pHqYq73dKd",
  sessionId: "session_admin01_whchoi_net",
  actorId: "admin01_whchoi_net",
  includePayloads: true,
  pageSize: 20
}
      │
      ▼
Response parsing:
  - Extract USER/ASSISTANT text from payload
  - Parse metadata from ASSISTANT text:
    [tools:get_container_status]  → Tools used
    [in:1200]                     → Input tokens
    [out:800]                     → Output tokens
    [time:2500]                   → Response time (ms)
      │
      ▼
Displayed in Dashboard "Chat History" section
```

### 5.4 Per-User Isolation

| Item | Value | Description |
|------|-------|-------------|
| **Memory ID** | Shared globally | One AgentCore Memory instance |
| **Session ID** | `session_{sanitized_email}` | Session separation based on user email |
| **Actor ID** | `{sanitized_email}` | User identification |
| **Isolation Level** | Session level | Cannot query other users' conversations |

---

<a id="en-voice-input"></a>
## 6. Voice Input (Web Speech API)

### 6.1 STT (Speech-to-Text) Flow

```
┌──────────┐                    ┌─────────────────┐
│  Browser  │                    │  Web Speech API  │
│  (React)  │                    │  (built-in)      │
└─────┬─────┘                    └────────┬────────┘
      │                                   │
      │ Click microphone button           │
      ├──────────────────────────────────>│
      │                                   │
      │         Speech recognition start   │
      │         (Korean or English)        │
      │                                   │
      │ onresult: recognized text          │
      │<──────────────────────────────────│
      │                                   │
      │ Auto-call sendMessage()            │
      │ (on recognition complete)          │
      │                                   │
```

### 6.2 Supported Languages

| Setting | Language Code | Behavior |
|---------|-------------|----------|
| Korean mode | `ko-KR` | Korean speech recognition → Korean response |
| English mode | `en-US` | English speech recognition → English response |

---

<a id="en-rendering"></a>
## 7. Response Rendering

### 7.1 Markdown Rendering

```
Claude response (raw):
  ## Container Status
  | User | OS | Tier | Status |
  |------|-----|------|--------|
  | admin01 | Ubuntu | Power | RUNNING |

  → Rendered with react-markdown + remark-gfm
  → Supports tables, code blocks, headers, etc.
```

### 7.2 Response Metadata Display

```
┌──────────────────────────────────────────────────────┐
│  (AI Response Markdown content)                       │
│                                                      │
│  Currently 6 containers are running...                │
│  | User | OS | Tier | Status |                       │
│  |------|-----|------|--------|                       │
│  | admin01 | Ubuntu | Power | RUNNING |              │
│                                                      │
│──────────────────────────────────────────────────────│
│  get_container_status                                │
│  In: 1,200 · Out: 800 tokens                        │
│  2.5s                                                │
│  via Bedrock Converse + Tool Use (Direct)    Copy    │
└──────────────────────────────────────────────────────┘
```

### 7.3 Copy Feature

```
Click "Copy" button
  → navigator.clipboard.writeText(msg.content)
  → Show "Copied" for 2 seconds
  → Revert to "Copy" icon
```

---

<a id="en-error-handling"></a>
## 8. Error Handling

| Scenario | Handling |
|----------|----------|
| Bedrock API error | Send error message via SSE → Display in UI |
| Tool execution failure | Return `{"error": "..."}` JSON → Claude provides error guidance |
| Over 5 iterations | Loop terminates, return last response |
| SSE connection lost | `controllerClosed` flag prevents double writes |
| Memory save failure | Ignored (catch → empty handler, conversation completes normally) |
| Auth failure | 403 Forbidden (admin group only) |

---

<a id="en-performance"></a>
## 9. Performance Characteristics

| Item | Value | Notes |
|------|-------|-------|
| **Model** | Sonnet 4.6 | 1/5 cost of Opus, 2-3x faster |
| **First Token Latency** | ~1 second | Perceived speed improved via SSE streaming |
| **Average Response Time** | 2~5 seconds | +1~2 seconds with Tool use |
| **Context Limit** | Last 8 messages | Token cost control |
| **Memory Save** | Async | Background after response completes |
| **Access Control** | Admin only | Regular users get 403 |

---

<a id="en-file-structure"></a>
## 10. Related File Structure

```
shared/nextjs-app/src/
├── app/
│   ├── ai/
│   │   └── ai-assistant.tsx       ← Frontend (React, SSE client, voice input)
│   └── api/
│       └── ai/
│           ├── route.ts           ← Bedrock Converse API + Tool Use handler
│           └── memory/
│               └── route.ts       ← AgentCore Memory CRUD (GET/POST)
├── lib/
│   ├── aws-clients.ts             ← listContainers() (ECS SDK)
│   └── cloudwatch-client.ts       ← getContainerMetrics() (CloudWatch SDK)
└── components/
    └── markdown-text.tsx          ← react-markdown renderer (remark-gfm)
```

---

<a id="en-agentcore-resources"></a>
## 11. AgentCore Resource Information

| Resource | ID/ARN | Purpose |
|----------|--------|---------|
| **AgentCore Runtime** | `cconbedrock_agent-xcceE4DydC` | AgentCore agent (ECR-based) |
| **AgentCore Memory** | `cconbedrock_memory-pHqYq73dKd` | Conversation memory store |
| **ECR Repository** | `cc-on-bedrock/agent` | AgentCore agent Docker image |
| **IAM Role** | `AWSopsAgentCoreRole` | AgentCore service execution permissions |
