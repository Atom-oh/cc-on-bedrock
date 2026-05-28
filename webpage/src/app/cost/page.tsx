"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Table, CodeBlock, Callout, Code } from "@/components/doc/primitives";

export default function CostPage() {
  const { t } = useLanguage();
  return (
    <PageShell
      title={t("비용 관리", "Cost Management")}
      subtitle={t(
        "대규모 사용자 환경에서도 효율적으로 예산을 관리할 수 있는 도구.",
        "Efficient budget management for large user bases."
      )}
    >
      <H2 id="ec2">{t("1. EC2-per-user DevEnv 모드 비용", "1. EC2 DevEnv cost")}</H2>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "price", label: t("단가 (ap-northeast-2)", "Unit price (ap-northeast-2)") },
          { key: "note", label: t("비고", "Note") },
        ]}
        rows={[
          { item: "EC2 t4g.large", price: "$0.0832 / hr", note: t("8h/day 기준 ~$20/월", "~$20/mo at 8h/day") },
          { item: "EBS gp3 root", price: "$0.08 / GB·월", note: t("40 GB 기본 → ~$3.2/월", "40 GB default → ~$3.2/mo") },
          { item: "Hibernation EBS", price: t("동일 (RAM 덤프 저장 포함)", "Same (RAM dump included)"), note: "ADR-010" },
          { item: <strong className="text-white">Bedrock API</strong>, price: t("모델/토큰별 종량제", "Per-model/token"), note: t("아래 단가 참조", "See pricing below") },
        ]}
      />
      <P>{t("ec2-idle-stop Lambda가 유휴 인스턴스를 자동 stop하므로 실제 24h 풀가동 비용은 발생하지 않습니다.", "ec2-idle-stop Lambda auto-stops idle instances, so 24h full-utilization cost is rare.")}</P>

      <H2 id="local">{t("2. Local Governance 모드 비용", "2. Local Governance cost")}</H2>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "price", label: t("단가", "Cost") },
          { key: "note", label: t("비고", "Note") },
        ]}
        rows={[
          { item: "EC2 / EBS", price: <strong className="text-accent-green">0</strong>, note: t("사용자 PC 사용", "User's own PC") },
          { item: t("Lambda (STS Issuer, enforcer, reset)", "Lambdas"), price: "~$0.1 / mo", note: t("호출 횟수 매우 적음", "Very low invocations") },
          { item: "DynamoDB (limits)", price: "~$0.01 / mo", note: t("on-demand, 수십 row", "On-demand, few rows") },
          { item: <strong className="text-white">Bedrock API</strong>, price: t("EC2 모드와 동일", "Same as EC2 mode"), note: t("모델/토큰별 종량제", "Per-model/token") },
        ]}
      />
      <P>{t("Local 모드에서는 인프라 비용이 사실상 0이며 Bedrock API 호출 비용만 발생.", "In Local mode, infra cost is effectively zero — only Bedrock API charges.")}</P>

      <H2 id="models">{t("3. Bedrock 모델 단가", "3. Bedrock model pricing")}</H2>
      <Table
        columns={[
          { key: "model", label: t("모델", "Model") },
          { key: "input", label: "Input / 1M tokens" },
          { key: "output", label: "Output / 1M tokens" },
        ]}
        rows={[
          { model: "Claude Opus 4.7", input: "$15.00", output: "$75.00" },
          { model: "Claude Opus 4.6", input: "$15.00", output: "$75.00" },
          { model: "Claude Sonnet 4.6", input: "$3.00", output: "$15.00" },
          { model: "Claude Haiku 4.5", input: "$0.80", output: "$4.00" },
        ]}
      />
      <Callout type="info" title={t("Normalized token 가중치 (ADR-015)", "Normalized token weights (ADR-015)")}>
        Haiku 1× · Sonnet ~3.5× · Opus ~15× — {t("다른 모델 간 가중치를 일관되게 적용해 한도 관리.", "consistent cross-model weighting for limit tracking.")}
      </Callout>

      <H2 id="pipeline">{t("4. 사용량 추적 파이프라인 (ADR-019)", "4. Usage tracking pipeline (ADR-019)")}</H2>
      <CodeBlock>
{`EC2 instance (Instance Profile credentials)
또는 사용자 PC (Local Mode, STS credentials)
  → Bedrock InvokeModel / Converse
  → Bedrock invocation logging (CloudWatch Logs, textData=false)
  → Subscription Filter (IAM role prefix 매칭)
  → bedrock-usage-tracker Lambda
  → cc-on-bedrock-usage DynamoDB (Streams)
  → token-limit-enforcer Lambda (Stream consumer)
  → 한도 초과 시 cc-on-bedrock-limits DENY#active + IAM Deny attach`}
      </CodeBlock>
      <P>
        {t(
          "이전 버전이 사용하던 CloudTrail + EventBridge 방식 대비 정확한 토큰 수까지 추적, textData=false로 CloudWatch Logs 비용 ~99% 절감.",
          "Compared to the older CloudTrail+EventBridge approach, this captures exact token counts; text/image/embedding off cuts CloudWatch Logs cost ~99%."
        )}
      </P>

      <H2 id="budget">{t("5. 예산 / 한도 제어 (ADR-015)", "5. Budget / limit enforcement (ADR-015)")}</H2>
      <H3>{t("5.1 USD 예산", "5.1 USD budget")} <Code>budget-check</Code></H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>{t("5분 주기 Lambda", "5-min cron Lambda")}</li>
        <li>{t("80% 도달 → SNS 경고", "80% → SNS alert")}</li>
        <li>{t("100% 도달 → IAM Deny attach", "100% → IAM Deny attach")}</li>
        <li>{t("익일 자정 (KST) → limit-reset Lambda가 Deny 자동 해제", "Daily KST midnight → limit-reset Lambda detaches Deny")}</li>
      </ul>
      <H3>{t("5.2 Normalized 토큰 한도", "5.2 Normalized token limit")} <Code>token-limit-enforcer</Code></H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>{t("usage table Streams 이벤트마다 normalized_tokens 누적", "Accumulates normalized_tokens per usage table Stream event")}</li>
        <li>{t("한도 초과 즉시 DENY#active + IAM Deny attach", "On exceed → DENY#active + IAM Deny attach")}</li>
        <li>KST {t("자정 (daily) / 일요일 (weekly) / 매월 1일 (monthly) reset", "midnight (daily) / Sunday (weekly) / 1st (monthly) reset")}</li>
      </ul>
      <Callout type="tip">
        {t("두 메커니즘은 독립적이며 어느 한쪽만이라도 트리거되면 사용자 차단.", "Both mechanisms are independent — either one triggers, the user is blocked.")}
      </Callout>

      <H2 id="tips">{t("6. 비용 절감 팁", "6. Cost-saving tips")}</H2>
      <ul className="text-sm text-gray-400 space-y-2 list-disc pl-5 mb-4">
        <li>{t("Hibernation 활성화 (ADR-010): ~5초 resume → 사용자가 stop을 꺼리지 않음", "Enable Hibernation (ADR-010): ~5s resume so users actually stop")}</li>
        <li>{t("ec2-idle-stop: CPU/Network 메트릭 기반 자동 stop. EBS는 유지", "ec2-idle-stop: auto-stop by CPU/Network metrics. EBS retained")}</li>
        <li>{t("EBS 적정 크기: 40 GB 시작 → user portal에서 확장 신청", "Right-size EBS: start 40 GB → request expand from user portal")}</li>
        <li>{t("Local Mode 활용: 본인 PC가 빠른 사용자는 Local로 → EC2 비용 0", "Use Local Mode: power-user PCs → zero EC2 cost")}</li>
        <li>{t("모델 가이드: 단순 변환은 Haiku, 복잡한 reasoning은 Opus. /model 픽커 활용", "Model guide: Haiku for simple, Opus for reasoning. Use /model picker")}</li>
      </ul>
    </PageShell>
  );
}
