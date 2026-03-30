import React, { useState } from 'react';
import styles from './AuthFlow.module.css';

const flows = [
  {
    id: 'dashboard',
    title: '대시보드 로그인',
    icon: '🖥️',
    steps: [
      { label: 'Browser', detail: '사용자가 대시보드 URL 접속' },
      { label: 'NextAuth', detail: 'Cognito Provider로 리다이렉트 (OAuth 2.0 Authorization Code)' },
      { label: 'Cognito Hosted UI', detail: '이메일/비밀번호 입력 (향후 SAML/OIDC 확장 가능)' },
      { label: 'JWT Session', detail: '8시간 세션, custom attributes (subdomain, tier, policy, groups)' },
      { label: 'Middleware', detail: '모든 라우트에서 JWT 검증, admin/dept-manager 역할 기반 접근 제어' },
    ],
  },
  {
    id: 'codeserver',
    title: 'code-server 접속',
    icon: '💻',
    steps: [
      { label: 'VSCode URL', detail: '{subdomain}.dev.domain — CloudFront → NLB → Nginx → Container' },
      { label: 'Password Auth', detail: 'code-server 비밀번호 입력 (Secrets Manager에서 로드)' },
      { label: 'Container', detail: 'code-server 세션 시작, EFS 마운트된 workspace 접근' },
      { label: 'Bedrock', detail: 'Claude Code가 per-user IAM Role로 Bedrock 직접 호출 (IMDS)' },
    ],
  },
  {
    id: 'password',
    title: '비밀번호 동기화',
    icon: '🔐',
    steps: [
      { label: '사용자 생성', detail: 'Admin → TemporaryPassword → Cognito + Secrets Manager 양쪽 저장' },
      { label: '첫 로그인', detail: 'Cognito Hosted UI에서 비밀번호 변경 (FORCE_CHANGE_PASSWORD)' },
      { label: '대시보드 변경', detail: 'Settings 탭 → AdminSetUserPassword + PutSecretValue 동시 업데이트' },
      { label: 'code-server 적용', detail: '다음 컨테이너 시작 시 Secrets Manager에서 새 비밀번호 로드' },
    ],
  },
];

export default function AuthFlow() {
  const [activeFlow, setActiveFlow] = useState('dashboard');
  const [activeStep, setActiveStep] = useState(0);

  const flow = flows.find(f => f.id === activeFlow)!;

  return (
    <div className={styles.container}>
      <h3>인증 & 접근 제어 아키텍처</h3>

      <div className={styles.tabs}>
        {flows.map(f => (
          <button
            key={f.id}
            className={`${styles.tab} ${activeFlow === f.id ? styles.activeTab : ''}`}
            onClick={() => { setActiveFlow(f.id); setActiveStep(0); }}
          >
            <span className={styles.tabIcon}>{f.icon}</span>
            {f.title}
          </button>
        ))}
      </div>

      <div className={styles.timeline}>
        {flow.steps.map((step, i) => (
          <div
            key={i}
            className={`${styles.step} ${activeStep === i ? styles.activeStep : ''} ${activeStep > i ? styles.completedStep : ''}`}
            onClick={() => setActiveStep(i)}
          >
            <div className={styles.dot}>
              {activeStep > i ? '✓' : i + 1}
            </div>
            <div className={styles.stepContent}>
              <div className={styles.stepLabel}>{step.label}</div>
              {activeStep === i && (
                <div className={styles.stepDetail}>{step.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
