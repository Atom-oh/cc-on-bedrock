"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Table, Callout, Code } from "@/components/doc/primitives";

export default function UserPortalPage() {
  const { t } = useLanguage();
  return (
    <PageShell
      title={t("내 환경 (User Portal)", "My Environment (User Portal)")}
      subtitle={t(
        "사용자 셀프서비스 포털 — 관리자 개입 없이 컨테이너 시작/중지, 디스크 관리, 비밀번호 설정 가능.",
        "Self-service portal — start/stop instances, manage disk, change password without admin intervention."
      )}
    >
      <H2 id="tabs">{t("3-탭 구조", "3-tab layout")}</H2>
      <Table
        columns={[
          { key: "tab", label: t("탭", "Tab") },
          { key: "feat", label: t("기능", "Features") },
        ]}
        rows={[
          { tab: t("환경 정보", "Environment"), feat: t("SSE 실시간 프로비저닝, 컨테이너 상태, VSCode URL, CPU/Memory 메트릭, 토큰 사용량", "Live SSE provisioning, instance status, VSCode URL, CPU/Memory metrics, token usage") },
          { tab: t("스토리지", "Storage"), feat: t("디스크 사용량 게이지, EBS 확장 신청/취소, Keep-Alive", "Disk gauge, EBS expansion request/cancel, Keep-Alive") },
          { tab: t("설정", "Settings"), feat: t("code-server 비밀번호 조회/변경, Cognito 동기화, 계정 정보", "code-server password view/change, Cognito sync, account info") },
        ]}
      />

      <H2 id="env">{t("환경 정보 탭", "Environment tab")}</H2>
      <H3>SSE {t("프로비저닝", "Provisioning")}</H3>
      <P>
        {t(
          "Start Container 버튼 클릭 시 6 단계가 실시간 진행됩니다 (1~2 분 소요). 일반적으로 Step 5 Container Start가 가장 오래 걸리며, Step 6 Network는 IP 할당을 최대 40초 대기.",
          "Clicking Start Container streams a 6-step progress (~1–2 min). Step 5 (Container Start) usually dominates; Step 6 (Network) waits up to 40 s for IP."
        )}
      </P>

      <H3>{t("일일 사용량", "Daily usage")}</H3>
      <Table
        columns={[
          { key: "range", label: t("구간", "Range") },
          { key: "color", label: t("색상", "Color") },
          { key: "mean", label: t("의미", "Meaning") },
        ]}
        rows={[
          { range: "0–70%", color: "🔵 Blue", mean: t("정상", "Normal") },
          { range: "70–90%", color: "🟡 Yellow", mean: t("주의", "Caution") },
          { range: "90–100%", color: "🔴 Red", mean: t("경고", "Warning") },
        ]}
      />

      <H2 id="storage">{t("스토리지 탭", "Storage tab")}</H2>
      <Table
        columns={[
          { key: "stype", label: t("스토리지 타입", "Storage type") },
          { key: "disp", label: t("표시 방식", "Display") },
        ]}
        rows={[
          { stype: "EBS", disp: t("게이지 바 (사용량/총용량, %) — 80% 이상 경고, 90% 이상 위험", "Gauge (used/total, %) — ≥80% caution, ≥90% danger") },
          { stype: "EFS", disp: t("사용량만 표시 (자동 확장, 용량 제한 없음)", "Usage only (auto-grow, no cap)") },
        ]}
      />
      <Callout type="warn" title={t("EBS 확장 신청 흐름", "EBS expansion flow")}>
        <ol className="space-y-1 list-decimal pl-5">
          <li>{t("희망 크기 선택 (40 / 60 / 100 GB)", "Choose target size (40 / 60 / 100 GB)")}</li>
          <li>{t("사유 입력 (최소 10자)", "Reason (min 10 chars)")}</li>
          <li>{t("AI Review — 사용 패턴 분석 후 권장 여부 판단", "AI Review — analyses usage and recommends size")}</li>
          <li>{t("관리자가 /admin 페이지에서 승인/거부", "Admin approves/rejects from /admin")}</li>
          <li>{t("승인 시 Lambda가 EBS 볼륨 자동 확장 (6 h 쿨다운)", "On approval, Lambda expands EBS (6 h cooldown)")}</li>
        </ol>
      </Callout>

      <H2 id="settings">{t("설정 탭 — code-server 비밀번호", "Settings tab — code-server password")}</H2>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li>{t("현재 비밀번호 확인 (마스킹 → 토글, 10초 자동 숨김)", "View current password (masked → toggle, auto-hide 10 s)")}</li>
        <li>{t("복사 버튼 + ✓ Copied! 피드백", "Copy button + ✓ feedback")}</li>
        <li>{t("비밀번호 변경 8~128자, 대문자/숫자/특수문자 필수", "Change password 8–128 chars, mixed case + digit + symbol")}</li>
        <li>{t("실행 중 변경 시 컨테이너 재시작 후 적용 (경고 배너)", "Mid-running change → applied after container restart (warning banner)")}</li>
      </ul>

      <H2 id="api">{t("API 레퍼런스", "API reference")}</H2>
      <Table
        columns={[
          { key: "ep", label: "Endpoint" },
          { key: "method", label: "Method" },
          { key: "use", label: t("용도", "Purpose") },
        ]}
        rows={[
          { ep: <Code>/api/user/container</Code>, method: "POST", use: t("컨테이너 시작/중지", "Start/stop instance") },
          { ep: <Code>/api/user/container/stream</Code>, method: "POST", use: t("SSE 프로비저닝 6단계", "SSE 6-step provisioning") },
          { ep: <Code>/api/user/container-metrics</Code>, method: "GET", use: t("CloudWatch 메트릭", "CloudWatch metrics") },
          { ep: <Code>/api/user/disk-usage</Code>, method: "GET", use: t("디스크 사용량", "Disk usage") },
          { ep: <Code>/api/user/ebs-resize</Code>, method: "GET/POST/DELETE", use: t("EBS 확장 신청/상태/취소", "EBS expansion request/status/cancel") },
          { ep: <Code>/api/user/password</Code>, method: "GET/POST", use: t("비밀번호 조회/변경", "Password get/set") },
          { ep: <Code>/api/user/usage</Code>, method: "GET", use: t("일일 토큰 사용량", "Daily token usage") },
          { ep: <Code>/api/user/keep-alive</Code>, method: "POST", use: t("유휴 타임아웃 연장", "Extend idle timeout") },
          { ep: <Code>/api/user/resource-review</Code>, method: "POST", use: t("AI 리소스 분석", "AI resource review") },
        ]}
      />
      <P>{t("모든 API는 NextAuth 세션 인증 필수이며, 본인 데이터만 접근 가능.", "All APIs require NextAuth session and access only to your own data.")}</P>
    </PageShell>
  );
}
