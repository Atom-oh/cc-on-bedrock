import React, { useState } from 'react';
import styles from './AzPinning.module.css';

const scenarios = [
  {
    id: 'first-start',
    title: '1. 첫 번째 시작',
    icon: '🆕',
    azA: { instances: ['🖥️'], tasks: [], ebs: [] },
    azC: { instances: [], tasks: [], ebs: [] },
    flow: [
      'RunTask → Capacity Provider 중 여유 있는 AZ 선택 (예: AZ-a)',
      'ASG가 AZ-a에 EC2 인스턴스 자동 생성 (2-3분)',
      'EBS 볼륨이 AZ-a에 생성 → /home/coder 마운트',
      'DynamoDB에 {user_id, az: "az-a"} 저장 → AZ 고정',
    ],
    highlight: 'a',
  },
  {
    id: 'restart-same',
    title: '2. 재시작 (같은 AZ)',
    icon: '🔄',
    azA: { instances: ['🖥️'], tasks: ['📦'], ebs: ['💾'] },
    azC: { instances: ['🖥️'], tasks: [], ebs: [] },
    flow: [
      'DynamoDB에서 AZ 조회 → "az-a"',
      'cc-cp-a Capacity Provider 선택 → AZ-a에만 배치',
      'AZ-a에 인스턴스 있음 → 즉시 배치 (5-10초)',
      'EBS 볼륨 직접 재사용 → 스냅샷 복원 불필요',
    ],
    highlight: 'a',
  },
  {
    id: 'az-full',
    title: '3. AZ-a 용량 부족',
    icon: '📈',
    azA: { instances: ['🖥️', '🖥️'], tasks: ['📦', '📦', '📦'], ebs: ['💾'] },
    azC: { instances: ['🖥️'], tasks: [], ebs: [] },
    flow: [
      'AZ-a 인스턴스가 모두 가득 참',
      'cc-cp-a Capacity Provider → ASG Scale Out 트리거',
      'ASG가 AZ-a에만 새 인스턴스 추가 (다른 AZ로 가지 않음!)',
      '새 인스턴스 Ready (2-3분) → 태스크 배치 → EBS 마운트',
    ],
    highlight: 'a',
  },
  {
    id: 'az-failure',
    title: '4. AZ 장애 (Fallback)',
    icon: '⚠️',
    azA: { instances: ['💀'], tasks: [], ebs: ['💾'] },
    azC: { instances: ['🖥️'], tasks: ['📦'], ebs: ['💾'] },
    flow: [
      'AZ-a 장애 감지 → cc-cp-a 배치 실패',
      'Fallback: 스냅샷에서 AZ-c에 새 EBS 볼륨 생성',
      'cc-cp-c Capacity Provider로 AZ-c에 배치',
      'DynamoDB AZ를 "az-c"로 업데이트 → 이후 AZ-c 고정',
    ],
    highlight: 'c',
  },
  {
    id: 'admin-move',
    title: '5. Admin AZ 변경',
    icon: '🔧',
    azA: { instances: ['🖥️'], tasks: [], ebs: ['💾'] },
    azC: { instances: ['🖥️'], tasks: ['📦'], ebs: ['💾'] },
    flow: [
      'Admin이 대시보드에서 사용자 AZ 변경 요청 (a → c)',
      '현재 EBS 스냅샷 생성 → 스냅샷에서 AZ-c에 복원',
      'DynamoDB AZ를 "az-c"로 업데이트',
      '다음 시작 시 AZ-c의 볼륨 직접 사용',
    ],
    highlight: 'c',
  },
];

export default function AzPinning() {
  const [active, setActive] = useState(0);
  const s = scenarios[active];

  return (
    <div className={styles.container}>
      <h3>AZ 고정 + Per-AZ Capacity Provider 동작 원리</h3>
      <p className={styles.subtitle}>EKS Karpenter 스타일 — AZ별 독립 스케일링으로 EBS 볼륨 직접 재사용</p>

      <div className={styles.scenarios}>
        {scenarios.map((sc, i) => (
          <button
            key={sc.id}
            className={`${styles.scenarioBtn} ${active === i ? styles.activeBtn : ''}`}
            onClick={() => setActive(i)}
          >
            <span>{sc.icon}</span>
            <span className={styles.btnLabel}>{sc.title}</span>
          </button>
        ))}
      </div>

      {/* AZ Diagram */}
      <div className={styles.azDiagram}>
        <div className={`${styles.az} ${s.highlight === 'a' ? styles.azHighlight : ''}`}>
          <div className={styles.azHeader}>
            <span className={styles.azName}>AZ-a</span>
            <span className={styles.cpName}>cc-cp-a</span>
          </div>
          <div className={styles.azContent}>
            <div className={styles.resources}>
              {s.azA.instances.map((inst, i) => <span key={`i${i}`} className={styles.resource}>{inst}</span>)}
              {s.azA.tasks.map((t, i) => <span key={`t${i}`} className={styles.resource}>{t}</span>)}
              {s.azA.ebs.map((e, i) => <span key={`e${i}`} className={styles.resource}>{e}</span>)}
              {s.azA.instances.length === 0 && s.azA.tasks.length === 0 && <span className={styles.empty}>empty</span>}
            </div>
          </div>
        </div>

        <div className={styles.azSeparator}>
          <div className={styles.separatorLine} />
          <span className={styles.separatorLabel}>ASG</span>
          <div className={styles.separatorLine} />
        </div>

        <div className={`${styles.az} ${s.highlight === 'c' ? styles.azHighlight : ''}`}>
          <div className={styles.azHeader}>
            <span className={styles.azName}>AZ-c</span>
            <span className={styles.cpName}>cc-cp-c</span>
          </div>
          <div className={styles.azContent}>
            <div className={styles.resources}>
              {s.azC.instances.map((inst, i) => <span key={`i${i}`} className={styles.resource}>{inst}</span>)}
              {s.azC.tasks.map((t, i) => <span key={`t${i}`} className={styles.resource}>{t}</span>)}
              {s.azC.ebs.map((e, i) => <span key={`e${i}`} className={styles.resource}>{e}</span>)}
              {s.azC.instances.length === 0 && s.azC.tasks.length === 0 && <span className={styles.empty}>empty</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Flow Steps */}
      <div className={styles.flowBox}>
        <h4>{s.icon} {s.title}</h4>
        <ol className={styles.flowSteps}>
          {s.flow.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>

      <div className={styles.legend}>
        🖥️ EC2 Instance &nbsp; 📦 ECS Task &nbsp; 💾 EBS Volume &nbsp; 💀 AZ 장애
      </div>
    </div>
  );
}
