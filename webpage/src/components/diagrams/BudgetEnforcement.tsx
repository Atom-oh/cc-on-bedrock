import React, { useState } from 'react';
import styles from './BudgetEnforcement.module.css';

const scenarios = [
  {
    id: 'normal',
    pct: 50,
    icon: '✅',
    title: '정상 (0-79%)',
    detail: '사용자가 정상적으로 Bedrock API를 호출합니다. 대시보드에 사용량 표시.',
    color: '#10b981',
    bar: 50,
  },
  {
    id: 'warning',
    pct: 85,
    icon: '⚠️',
    title: '경고 (80-99%)',
    detail: 'SNS 알림 발송. 사용자에게 "예산 80% 도달" 경고. 관리자/부서 관리자에게도 통지.',
    color: '#f59e0b',
    bar: 85,
  },
  {
    id: 'exceeded',
    pct: 100,
    icon: '🚫',
    title: '초과 (100%+)',
    detail: 'IAM Deny Policy 자동 부착 → Bedrock API 호출 차단. Cognito budget_exceeded 플래그 설정. SNS 긴급 알림.',
    color: '#ef4444',
    bar: 100,
  },
  {
    id: 'release',
    pct: 0,
    icon: '🔓',
    title: '자동 해제 (다음 날)',
    detail: '다음 날 5분 주기 체크에서 사용량 리셋 확인 → IAM Deny Policy 자동 제거 + Cognito 플래그 해제.',
    color: '#3b82f6',
    bar: 5,
  },
];

const deptScenarios = [
  {
    id: 'dept-warn',
    icon: '📊',
    title: '부서 경고 (80%)',
    detail: '부서 월간 예산 80% 도달. 부서 관리자에게 SNS 경고. 개별 사용자는 영향 없음.',
  },
  {
    id: 'dept-block',
    icon: '🏢',
    title: '부서 차단 (100%)',
    detail: '부서 전체 사용자에게 DeptBudgetExceededDeny Policy 부착. 해당 부서 모든 사용자의 Bedrock 접근 차단.',
  },
];

export default function BudgetEnforcement() {
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<'user' | 'dept'>('user');

  const scenario = scenarios[active];

  return (
    <div className={styles.container}>
      <h3>예산 초과 자동 대응 메커니즘</h3>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'user' ? styles.activeTab : ''}`}
          onClick={() => setTab('user')}
        >
          👤 사용자 일일 예산
        </button>
        <button
          className={`${styles.tab} ${tab === 'dept' ? styles.activeTab : ''}`}
          onClick={() => setTab('dept')}
        >
          🏢 부서 월간 예산
        </button>
      </div>

      {tab === 'user' ? (
        <>
          <div className={styles.stages}>
            {scenarios.map((s, i) => (
              <button
                key={s.id}
                className={`${styles.stage} ${active === i ? styles.activeStage : ''}`}
                onClick={() => setActive(i)}
                style={{ '--stage-color': s.color } as React.CSSProperties}
              >
                <span className={styles.stageIcon}>{s.icon}</span>
                <span className={styles.stageLabel}>{s.pct}%</span>
              </button>
            ))}
          </div>

          {/* Animated bar */}
          <div className={styles.barContainer}>
            <div className={styles.barBg}>
              <div
                className={styles.barFill}
                style={{
                  width: `${scenario.bar}%`,
                  backgroundColor: scenario.color,
                  transition: 'all 0.5s ease',
                }}
              />
            </div>
            <div className={styles.barLabels}>
              <span>0%</span>
              <span style={{ left: '80%', position: 'absolute', color: '#f59e0b', fontSize: '0.7rem' }}>80%</span>
              <span>100%</span>
            </div>
          </div>

          <div className={styles.detail} style={{ borderLeftColor: scenario.color }}>
            <h4>{scenario.icon} {scenario.title}</h4>
            <p>{scenario.detail}</p>
          </div>
        </>
      ) : (
        <div className={styles.deptList}>
          {deptScenarios.map((s) => (
            <div key={s.id} className={styles.deptItem}>
              <span className={styles.deptIcon}>{s.icon}</span>
              <div>
                <h4>{s.title}</h4>
                <p>{s.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
