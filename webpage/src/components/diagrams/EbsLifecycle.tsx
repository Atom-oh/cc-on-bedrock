import React, { useState } from 'react';
import styles from './EbsLifecycle.module.css';

const phases = [
  {
    id: 'create',
    icon: '💾',
    label: 'Create',
    title: '볼륨 생성',
    detail: 'ECS Managed EBS Volume — gp3 20GB (또는 승인된 크기), 3000 IOPS. 스냅샷이 있으면 복원, 없으면 새 볼륨.',
    color: '#3b82f6',
  },
  {
    id: 'mount',
    icon: '📂',
    label: 'Mount',
    title: '/home/coder 마운트',
    detail: 'ext4 포맷, ECS Task에 자동 연결. code-server + Claude Code + Kiro 워크스페이스로 사용.',
    color: '#10b981',
  },
  {
    id: 'sync',
    icon: '🔄',
    label: 'S3 Sync',
    title: '5분 주기 S3 동기화',
    detail: '/home/coder/workspace/ → S3 증분 동기화. dotfile (.claude, .config)은 EBS 스냅샷에만 보존.',
    color: '#8b5cf6',
  },
  {
    id: 'idle',
    icon: '⏱️',
    label: 'Idle Check',
    title: '유휴 감지 (5분 주기)',
    detail: 'CPU < 5% + Network < 1KB/s → 30분 경고, 45분 Warm-Stop. Keep-Alive 연장 가능.',
    color: '#f59e0b',
  },
  {
    id: 'snapshot',
    icon: '📸',
    label: 'Snapshot',
    title: 'EBS 스냅샷 생성',
    detail: 'SIGTERM → S3 풀백업 → EBS 스냅샷 생성 (증분). 전체 블록 디바이스 보존.',
    color: '#ec4899',
  },
  {
    id: 'delete',
    icon: '🗑️',
    label: 'Delete',
    title: '볼륨 삭제',
    detail: '스냅샷 완료 후 볼륨 삭제. DynamoDB에 snapshot_id 기록. 비용 $0 (스냅샷만 유지).',
    color: '#ef4444',
  },
  {
    id: 'restore',
    icon: '♻️',
    label: 'Restore',
    title: '스냅샷에서 복원',
    detail: '재시작 시 DynamoDB에서 snapshot_id 조회 → 새 볼륨 생성 + 데이터 복원. 원래 상태로 즉시 복구.',
    color: '#06b6d4',
  },
];

export default function EbsLifecycle() {
  const [active, setActive] = useState(0);

  return (
    <div className={styles.container}>
      <h3>EBS 볼륨 라이프사이클</h3>
      <p className={styles.subtitle}>각 단계를 클릭하여 상세 동작을 확인하세요.</p>

      <div className={styles.timeline}>
        {phases.map((phase, i) => (
          <div
            key={phase.id}
            className={`${styles.phase} ${active === i ? styles.active : ''}`}
            onClick={() => setActive(i)}
            style={{ '--phase-color': phase.color } as React.CSSProperties}
          >
            <div className={styles.dot}>{phase.icon}</div>
            <div className={styles.label}>{phase.label}</div>
          </div>
        ))}
      </div>

      <div className={styles.detail} style={{ borderLeftColor: phases[active].color }}>
        <h4>{phases[active].icon} {phases[active].title}</h4>
        <p>{phases[active].detail}</p>
        <div className={styles.stepInfo}>
          Step {active + 1} / {phases.length}
          {active === phases.length - 1 && ' → Create로 순환'}
        </div>
      </div>
    </div>
  );
}
