import React, { useState } from 'react';
import styles from './EbsLifecycle.module.css';

const phases = [
  {
    id: 'provision',
    icon: '🚀',
    label: 'Provision',
    title: 'EC2 인스턴스 생성',
    detail: 'AMI에서 RunInstances — code-server, Claude Code, Kiro 사전 설치. t4g.large (2vCPU/8GB). 30GB gp3 EBS root volume. SSM only (SSH 비활성).',
    color: '#3b82f6',
  },
  {
    id: 'running',
    icon: '💻',
    label: 'Running',
    title: 'code-server 실행 중',
    detail: 'systemd code-server 자동 시작. Nginx가 {subdomain}.dev.domain → instance IP:8080 라우팅. 파일, 패키지, 설정 모두 EBS root volume에 저장.',
    color: '#10b981',
  },
  {
    id: 'idle',
    icon: '⏱️',
    label: 'Idle Check',
    title: '유휴 감지 (5분 주기)',
    detail: 'CloudWatch AWS/EC2 표준 메트릭 — CPU < 5% + Network < 1KB/s + Bedrock 미사용 → 30분 경고, 45분 자동 Stop. Keep-Alive 연장 가능.',
    color: '#f59e0b',
  },
  {
    id: 'stop',
    icon: '⏸️',
    label: 'Stop',
    title: 'EC2 Stop (데이터 보존)',
    detail: 'StopInstances — EBS root volume 자동 보존. Snapshot 불필요, S3 백업 불필요. 컴퓨트 비용 $0, EBS 스토리지만 과금 ($0.08/GB/월).',
    color: '#ec4899',
  },
  {
    id: 'start',
    icon: '▶️',
    label: 'Start',
    title: '재시작 (30-75초)',
    detail: 'StartInstances → 동일 EBS 자동 재연결. 모든 파일, apt 패키지, npm -g, pip 설치 패키지, 시스템 설정 완벽 보존. code-server 자동 시작.',
    color: '#06b6d4',
  },
  {
    id: 'migrate',
    icon: '🔄',
    label: 'AZ 이전',
    title: 'AZ 장애 시 (Admin)',
    detail: 'EBS Snapshot → 다른 AZ에서 새 인스턴스 생성 → Snapshot에서 volume 복원. 일반 운영에서는 불필요, 장애 시에만 사용.',
    color: '#8b5cf6',
  },
];

export default function Ec2Lifecycle() {
  const [active, setActive] = useState(0);

  return (
    <div className={styles.container}>
      <h3>EC2 인스턴스 라이프사이클</h3>
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
          {active === 4 && ' → Running으로 순환'}
        </div>
      </div>
    </div>
  );
}
