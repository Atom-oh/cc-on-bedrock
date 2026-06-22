"use client";

import Link from "next/link";
import { useLanguage } from "@/lib/i18n";
import { asset } from "@/lib/assets";
import { PageShell, H2, H3, P, Code, CodeBlock, Tag, Callout, Table } from "@/components/doc/primitives";

export default function UserPortalPage() {
  const { t } = useLanguage();

  return (
    <PageShell
      title={t("내 환경 사용법", "Using My Environment")}
      subtitle={t(
        "대시보드 로그인 직후 내가 매일 하는 작업 흐름. 인스턴스 켜기, code-server / claude 사용하기, 디스크가 부족하면 늘리기, 다 끝나면 끄기.",
        "What you actually do every day from sign-in to shutdown: start your instance, use code-server / claude, expand the disk when it fills up, and stop cleanly when you're done."
      )}
      tags={[
        { label: t("사용자 가이드", "User guide"), color: "cyan" },
      ]}
    >
      {/* Quick start */}
      <Callout type="tip" title={t("3분 빠른 시작 (Quickstart)", "3-min quickstart")}>
        <ol className="space-y-1.5 list-decimal pl-5 text-sm">
          <li>
            {t("회사 도메인의 대시보드(예: ", "Visit your dashboard (e.g. ")}
            <Code>https://cconbedrock-dashboard.&lt;your-domain&gt;</Code>
            {t(")에 회사 이메일/비밀번호로 로그인", ") and sign in with your work email/password")}
          </li>
          <li>
            {t("좌측 사이드바 → ", "Left sidebar → ")}
            <strong className="text-white">{t("내 환경", "My Environment")}</strong>
            {t(" 클릭", "")}
          </li>
          <li>
            {t("인스턴스 상태에 따라 ", "Depending on the instance state, click ")}
            <Code>Start</Code> / <Code>Resume</Code>
            {t(" 버튼 클릭 — 약 5~30초 대기", " — wait ~5–30 s")}
          </li>
          <li>
            {t("\"VSCode 열기\" / 서브도메인 링크 클릭 → 브라우저에서 VS Code(code-server) 실행", "Click the VSCode link / your subdomain → code-server opens in the browser")}
          </li>
          <li>
            {t("터미널에서 ", "In the terminal, type ")}
            <Code>claude</Code>
            {t(" 또는 ", " or ")}
            <Code>kiro</Code>
            {t(" 실행 → Bedrock 자격증명이 자동으로 잡혀 있음", " — Bedrock credentials are auto-loaded")}
          </li>
        </ol>
      </Callout>

      <H2 id="environment">{t("1. 환경 정보 탭 — 인스턴스 켜고 작업하기", "1. Environment tab — start and work")}</H2>
      <P>
        {t(
          "내 환경의 첫 화면. 인스턴스 상태(Running / Hibernated / Stopped), Bedrock 자격증명, 오늘 토큰 사용량을 한 눈에 볼 수 있습니다.",
          "The first thing you see in My Environment. Instance state (Running / Hibernated / Stopped), Bedrock credentials, and today's token usage at a glance."
        )}
      </P>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/user-portal-environment.png")} alt={t("환경 정보 탭", "Environment tab")} className="w-full h-auto" />
      </div>

      <H3>{t("1-A. 인스턴스 상태 배지", "1-A. Instance state badge")}</H3>
      <Table
        columns={[
          { key: "state", label: t("상태", "State") },
          { key: "mean", label: t("의미", "Meaning") },
          { key: "do", label: t("내가 할 행동", "What to do") },
        ]}
        rows={[
          { state: <Tag color="green">Running</Tag>, mean: t("이미 켜져 있음", "Already on"), do: t("바로 VSCode 링크 클릭", "Click the VSCode link") },
          { state: <Tag color="cyan">Hibernated</Tag>, mean: t("메모리 상태 보존 → ~5초 안에 깨움", "Memory preserved — wakes in ~5 s"), do: <><Code>Resume</Code> {t("클릭", "click")}</> },
          { state: <Tag color="orange">Stopped</Tag>, mean: t("완전히 꺼짐 → cold start ~30초", "Fully off — cold start ~30 s"), do: <><Code>Start</Code> {t("클릭", "click")}</> },
          { state: <Tag color="purple">Pending</Tag>, mean: t("프로비저닝/시작 중", "Provisioning/starting"), do: t("대기 — 6단계 진행 표시", "Wait — 6-step progress shown") },
          { state: <Tag color="red">Stopping</Tag>, mean: t("종료 중", "Stopping"), do: t("완료 후 다시 Start", "Start again once stopped") },
        ]}
      />

      <H3>{t("1-B. 처음 시작할 때 — 6단계 프로비저닝", "1-B. First start — 6-step provisioning")}</H3>
      <P>
        {t(
          "내 인스턴스가 아직 없을 때 Start를 누르면 6단계로 약 1~2분 동안 진행 상황이 실시간 표시됩니다. 가장 오래 걸리는 건 Step 5 (Container Start, 30~60초).",
          "If you don't have an instance yet, clicking Start streams 6 steps in real time over ~1–2 min. Step 5 (Container Start) usually dominates at 30–60 s."
        )}
      </P>
      <ol className="text-sm text-gray-400 space-y-1 list-decimal pl-5 mb-4">
        <li>{t("권한 설정 (IAM Role)", "Permission setup (IAM Role)")} — 5~15 s</li>
        <li>{t("스토리지 준비", "Storage prep")} — 5~10 s</li>
        <li>{t("환경 구성", "Environment config")} — 3~5 s</li>
        <li>{t("접근 보안 (비밀번호 동기화)", "Access security (password sync)")} — 2~3 s</li>
        <li>{t("컨테이너 시작", "Container start")} — <strong className="text-accent-orange">30~60 s</strong></li>
        <li>{t("네트워크 연결 (IP 할당)", "Network connect (IP assignment)")} — 5~40 s</li>
      </ol>
      <Callout type="info">
        {t("중단하고 싶으면 진행 카드 우측 상단의 Cancel 버튼을 누르세요. 이미 시작된 EC2 인스턴스가 있으면 자동 정리됩니다.", "If you want to abort, hit the Cancel button on the progress card; any partially started resources are auto-cleaned.")}
      </Callout>

      <H3>{t("1-C. 켜진 다음 — VSCode 열기", "1-C. Once it's running — open VSCode")}</H3>
      <P>
        {t(
          "Running 배지가 뜨면 다음 정보가 펼쳐집니다:",
          "Once the Running badge shows, the card expands with:"
        )}
      </P>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li>
          <strong className="text-white">VSCode URL</strong> — <Code>https://{"{subdomain}"}.dev.{"{domain}"}</Code>{" "}
          {t("클릭하면 새 탭에서 code-server 실행, 복사 아이콘으로 클립보드 복사도 가능", "Click to open code-server in a new tab; copy icon copies to clipboard")}
        </li>
        <li>
          <strong className="text-white">{t("리소스 등급", "Resource tier")}</strong> — Light (1 vCPU / 4 GiB), Standard (2 / 8), Power (4 / 12).{" "}
          {t("드롭다운으로 변경 가능 — Stop 후 다시 Start하면 적용", "Pick from the dropdown — Stop & Start to apply")}
        </li>
        <li>
          <strong className="text-white">CPU / Memory / Network</strong> — {t("실시간 게이지 + 미니 차트 (CloudWatch 5초 폴링)", "Live gauges + mini chart (5-s CloudWatch polling)")}
        </li>
      </ul>

      <H3>{t("1-D. 오늘 사용량 카드", "1-D. Today's usage card")}</H3>
      <P>
        {t(
          "환경 정보 탭 하단에 본인 일일 토큰 사용량이 progress bar로 표시됩니다.",
          "A progress bar at the bottom of the Environment tab shows your daily token usage."
        )}
      </P>
      <Table
        columns={[
          { key: "range", label: t("구간", "Range") },
          { key: "color", label: t("색상", "Color") },
          { key: "mean", label: t("의미", "Meaning") },
        ]}
        rows={[
          { range: "0–70%", color: "🔵 Blue", mean: t("정상 — 계속 작업", "Normal — keep working") },
          { range: "70–90%", color: "🟡 Yellow", mean: t("주의 — 큰 작업 시작 전 본인 한도 확인", "Caution — check your limit before kicking off big jobs") },
          { range: "90–100%", color: "🔴 Red", mean: t("경고 — 일일 한도 도달 임박. 자정 (KST) 자동 reset", "Warning — daily limit close. Auto-reset at midnight KST") },
        ]}
      />
      <Callout type="warn">
        {t("한도 초과 시 Bedrock 호출이 자동으로 차단됩니다. 즉시 복구가 필요하면 관리자에게 reset 요청.", "When the limit is exceeded, Bedrock calls are blocked automatically. Ask an admin to reset if you need immediate relief.")}
      </Callout>

      <H3 id="local-mode">{t("1-E. (옵션) Local 모드로 본인 PC에서 claude 실행", "1-E. (Optional) Run claude on your own PC with Local mode")}</H3>
      <P>
        {t(
          "EC2 인스턴스를 띄우지 않고 본인 노트북에서 직접 claude를 실행하고 싶다면, 환경 정보 탭 상단의 \"Local (Bedrock) — Claude Code on your machine\" 박스에서 한 줄 설치 스크립트를 받을 수 있습니다.",
          "If you'd rather run claude on your own laptop without spinning up an EC2, the \"Local (Bedrock)\" panel at the top of the Environment tab gives you a one-line install."
        )}
      </P>
      <CodeBlock lang="bash">
{`# 1) 설치 (대시보드 'Generate script' 버튼이 본인 토큰 임베디드 버전을 만들어줌)
curl -fsSL https://cconbedrock-dashboard.<your-domain>/api/install | bash

# 2) 사용
cc                # claude 자동 자격증명 + 실행
cc-bedrock-local status   # 잔여 시간 / 한도 / Deny 상태 확인`}
      </CodeBlock>
      <P>
        {t("자세한 Local 모드 가이드는 ", "See the full ")}
        <Link href="/local-mode" className="text-accent-cyan hover:underline">/local-mode</Link>
        {t(" 페이지 참고.", " page for the full Local mode guide.")}
      </P>

      {/* Storage tab */}
      <H2 id="storage">{t("2. 스토리지 탭 — 디스크 부족하면 늘리기", "2. Storage tab — expand disk when it fills")}</H2>
      <P>
        {t(
          "인스턴스가 Running일 때만 디스크 사용량이 표시됩니다. (Stopped/Hibernated 상태에선 \"Instance must be running\" 메시지)",
          "Disk usage is only shown while the instance is Running. (Stopped/Hibernated shows \"Instance must be running\".)"
        )}
      </P>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/user-portal-storage.png")} alt={t("스토리지 탭", "Storage tab")} className="w-full h-auto" />
      </div>

      <H3>{t("2-A. 게이지 색상", "2-A. Gauge colors")}</H3>
      <Table
        columns={[
          { key: "pct", label: t("사용률", "Usage") },
          { key: "color", label: t("색상", "Color") },
          { key: "mean", label: t("의미", "Meaning") },
        ]}
        rows={[
          { pct: "0–80%", color: "🟢 Green", mean: t("여유", "Plenty of room") },
          { pct: "80–90%", color: "🟡 Yellow", mean: t("주의 — 큰 git clone / docker pull 전 정리하거나 확장 신청", "Caution — clean up or request expansion before big clones") },
          { pct: "90%+", color: "🔴 Red", mean: t("위험 — 즉시 확장 신청 권장", "Critical — request expansion now") },
        ]}
      />

      <H3>{t("2-B. EBS 확장 신청", "2-B. Request EBS expansion")}</H3>
      <P>{t("EBS GP3 저장소 확장이 필요할 때 관리자 승인으로 처리됩니다.", "EBS GP3 expansion is handled through admin approval.")}</P>
      <ol className="text-sm text-gray-400 space-y-1.5 list-decimal pl-5 mb-4">
        <li>
          <strong className="text-white">{t("희망 크기 선택", "Pick target size")}</strong> — 40 / 60 / 100 GB ({t("현재보다 커야 함", "must be larger than current")})
        </li>
        <li>
          <strong className="text-white">{t("사유 입력", "Reason")}</strong> — {t("최소 10자 (예: \"Docker 이미지 캐시 + node_modules\")", "min 10 chars (e.g. \"Docker cache + node_modules\")")}
        </li>
        <li>
          <strong className="text-white">AI Review</strong> — {t("AI가 본인 최근 사용 패턴을 분석해 권장 크기를 알려줍니다", "AI analyses your recent usage and suggests a size")}
        </li>
        <li>
          <strong className="text-white">{t("관리자 승인 대기", "Wait for admin approval")}</strong> — {t("Approve되면 Lambda가 다음 인스턴스 시작 시 적용", "Once approved, Lambda applies it on next instance start")}
        </li>
      </ol>
      <Callout type="warn">
        <strong className="text-white">{t("EBS 6시간 쿨다운", "EBS 6-hour cooldown")}:</strong>{" "}
        {t("리사이즈 직후 6시간 내 재수정 불가. AWS 제약이라 우회 방법 없음.", "After a resize you can't modify the volume again for 6 hours. AWS-imposed, no workaround.")}
      </Callout>

      <H3>{t("2-C. Keep-Alive — 자동 종료 방지", "2-C. Keep-Alive — block auto-stop")}</H3>
      <P>
        {t(
          "기본적으로 인스턴스가 30분간 유휴 상태(CPU < 5% + 네트워크 < 1 KB/s)면 자동 종료됩니다. 큰 빌드나 ML 학습 등을 백그라운드로 돌리는 경우 ",
          "By default, the instance auto-stops after 30 min idle (CPU < 5% + network < 1 KB/s). For long-running builds or background ML training, click "
        )}
        <strong className="text-white">{t("Extend 1 Hour", "Extend 1 Hour")}</strong>
        {t(" 버튼을 누르면 1시간 추가 연장.", " to push the timeout by another hour.")}
      </P>

      {/* Settings tab */}
      <H2 id="settings">{t("3. 설정 탭 — 비밀번호 바꾸기", "3. Settings tab — change password")}</H2>
      <P>
        {t(
          "code-server에 접속할 때 쓰는 비밀번호를 여기서 보고 / 복사 / 변경합니다. 회사 계정(Cognito) 비밀번호와 처음엔 같지만 변경하면 양쪽이 동시에 갱신됩니다.",
          "View / copy / change the password used for code-server. It starts identical to your Cognito account password, and changing it updates both stores simultaneously."
        )}
      </P>
      <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/img/user-portal-settings.png")} alt={t("설정 탭", "Settings tab")} className="w-full h-auto" />
      </div>

      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li>
          <strong className="text-white">{t("현재 비밀번호 보기", "Show password")}</strong> — {t("눈 아이콘 토글, 10초 후 자동으로 다시 마스킹", "Eye icon toggle, auto-masks after 10 s")}
        </li>
        <li>
          <strong className="text-white">{t("복사", "Copy")}</strong> — {t("클릭 후 ✓ Copied! 표시", "Click → ✓ Copied! confirmation")}
        </li>
        <li>
          <strong className="text-white">{t("변경", "Change")}</strong> — {t("8~128자, 대문자 + 숫자 + 특수문자 필수", "8–128 chars, must include uppercase + digit + symbol")}
        </li>
        <li>
          <strong className="text-accent-orange">{t("실행 중 변경 주의", "Note while running")}</strong> — {t("재시작 후 code-server에 새 비밀번호가 반영됨 (변경 후 노란 배너로 안내)", "New password applies to code-server only after restart (a yellow banner reminds you)")}
        </li>
      </ul>

      <H3>{t("계정 정보 (읽기 전용)", "Account info (read-only)")}</H3>
      <P>{t("이메일, 본인 서브도메인, 소속 그룹(user/dept-manager/admin), 보안 정책(open/restricted/locked), OS, 스토리지 타입, VSCode URL 가 함께 표시됩니다. 이 중 변경하고 싶은 항목은 관리자에게 요청하세요.", "Email, your subdomain, group (user/dept-manager/admin), security policy (open/restricted/locked), OS, storage type, and VSCode URL. To change any of these, ask an admin.")}</P>

      {/* Daily workflow tips */}
      <H2 id="workflow">{t("4. 매일 쓰는 작업 흐름", "4. The daily workflow")}</H2>
      <Callout type="tip" title={t("아침에 출근해서", "Morning routine")}>
        <ol className="space-y-1 list-decimal pl-5">
          <li>{t("대시보드 → 내 환경 → Resume (Hibernated였다면 ~5초)", "Dashboard → My Environment → Resume (~5 s if hibernated)")}</li>
          <li>{t("VSCode URL 클릭 → 어제 작업하던 그대로 열림 (파일 / 터미널 세션 보존)", "Click VSCode URL → resumes exactly where you left off (files + terminals preserved)")}</li>
          <li>{t("터미널에서 claude 또는 kiro 실행", "Run claude or kiro in the terminal")}</li>
        </ol>
      </Callout>
      <Callout type="tip" title={t("점심 / 자리 비울 때", "Lunch / stepping away")}>
        {t("아무것도 안 해도 됩니다. 30분 후 자동으로 Hibernate. 돌아와서 Resume 누르면 5초 안에 복귀.", "Nothing to do — auto-hibernates after 30 min. Hit Resume on return and you're back in 5 s.")}
      </Callout>
      <Callout type="tip" title={t("퇴근할 때", "End of day")}>
        {t(
          "Stop 버튼을 직접 누르는 것을 권장. EOD 일괄 정리도 매일 18:00 KST에 돌아 자동 정지하지만, 본인이 명시적으로 끄면 EBS 청구 시간이 그만큼 절약됩니다.",
          "Hit Stop yourself if you can. The EOD batch at 18:00 KST will stop it for you, but stopping manually saves EBS-hour charges."
        )}
      </Callout>

      {/* Troubleshooting */}
      <H2 id="troubleshooting">{t("5. 자주 겪는 문제", "5. Common issues")}</H2>

      {[
        {
          symptom: t("Start 눌렀는데 Step 5에서 멈춤", "Start hangs at Step 5"),
          why: t("EC2 Capacity Provider가 인스턴스를 새로 띄우는 중일 수 있음 (사용자 많을 때)", "EC2 Capacity Provider may be scaling up (busy hours)"),
          fix: t("최대 2~3분 더 대기. 안 풀리면 Cancel 후 다시 시도 또는 관리자 문의", "Wait up to another 2–3 min. If still stuck, Cancel and retry, or ping an admin"),
        },
        {
          symptom: t("VSCode URL 클릭했는데 502 / 빈 화면", "VSCode URL gives 502 / blank page"),
          why: t("Nginx routing이 아직 5초 hot-reload 안 됐을 수 있음", "Nginx routing may not have hot-reloaded (5 s cycle)"),
          fix: t("10초 기다리고 새로고침. 그래도 안 되면 인스턴스 Stop → Start", "Wait 10 s and refresh. Still broken → Stop and Start the instance"),
        },
        {
          symptom: t("터미널에서 claude 실행 시 \"credentials not found\"", "claude says \"credentials not found\""),
          why: t("Instance Profile 자격증명 갱신이 안 됐음", "Instance Profile creds didn't refresh"),
          fix: <><Code>aws sts get-caller-identity</Code> {t("로 확인 후 인스턴스 재시작", "to verify, then restart the instance")}</>,
        },
        {
          symptom: t("\"You have exceeded your daily limit\" (Bedrock)", "\"You have exceeded your daily limit\" (Bedrock)"),
          why: t("일일 토큰 한도 도달", "Hit your daily token limit"),
          fix: t("자정 KST 자동 reset. 즉시 필요하면 관리자에게 reset 또는 한도 상향 요청", "Auto-resets at midnight KST. For immediate relief, ask an admin to reset or raise the limit"),
        },
        {
          symptom: t("EBS 확장 신청했는데 적용 안 됨", "EBS expansion approved but not applied"),
          why: t("AWS의 6시간 modify cooldown 또는 인스턴스를 한 번 더 시작해야 적용", "AWS 6-hour modify cooldown, or needs another Start cycle"),
          fix: t("Stop → 6시간 경과 확인 → Start. 그래도 안 되면 관리자에게 신청 ID와 함께 문의", "Stop → wait 6h → Start. If still failing, ping admin with your request ID"),
        },
        {
          symptom: t("VSCode 비밀번호 모름 / 잊었음", "Forgot the code-server password"),
          why: t("설정 탭에서 항상 확인 가능", "It's always shown in Settings"),
          fix: t("설정 탭 → 비밀번호 → 눈 아이콘 토글 → 복사", "Settings → Password → eye toggle → copy"),
        },
        {
          symptom: t("Hibernate 후 Resume 했는데 ~5초 안에 안 깨어남", "Resume from Hibernate is slow (> 5 s)"),
          why: t("Hibernation 60일 회전 한도에 도달했거나 메모리 페이지가 너무 큼", "60-day hibernation rotation expired, or memory image is large"),
          fix: t("일단 Stop → Start (cold start). 자주 발생하면 관리자에게 문의", "Stop and Start (cold). If recurring, ping admin"),
        },
      ].map((tip, i) => (
        <div key={i} className="rounded-lg border border-navy-600 bg-navy-800/40 p-4 mb-3">
          <div className="text-sm font-bold text-white mb-2">{tip.symptom}</div>
          <div className="text-xs text-gray-500 mb-1">
            <span className="text-accent-red font-semibold">{t("원인", "Why")}:</span> {tip.why}
          </div>
          <div className="text-xs text-gray-400">
            <span className="text-accent-green font-semibold">{t("조치", "Fix")}:</span> {tip.fix}
          </div>
        </div>
      ))}

      {/* Related */}
      <H2 id="related">{t("6. 더 알아보기", "6. Related guides")}</H2>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li>
          <Link href="/local-mode" className="text-accent-cyan hover:underline">/local-mode</Link>
          {" — "}
          {t("본인 PC에서 claude 직접 실행 (EC2 비용 0)", "Run claude on your own PC (zero EC2 cost)")}
        </li>
        <li>
          <Link href="/usage" className="text-accent-cyan hover:underline">/usage</Link>
          {" — "}
          {t("대시보드의 다른 메뉴들 (분석 / 모니터링 / AI 비서)", "The other dashboard menus (Analytics / Monitoring / AI Assistant)")}
        </li>
        <li>
          <Link href="/security" className="text-accent-cyan hover:underline">/security</Link>
          {" — "}
          {t("DLP 정책 (Open / Restricted / Locked) 가 내 작업에 어떤 영향을 주는지", "How the DLP policy (Open / Restricted / Locked) affects what you can download/upload")}
        </li>
        <li>
          <Link href="/faq" className="text-accent-cyan hover:underline">/faq</Link>
          {" — "}
          {t("스토리지, 인증, 비용에 대한 자주 묻는 질문", "FAQ on storage, auth, cost")}
        </li>
      </ul>
    </PageShell>
  );
}
