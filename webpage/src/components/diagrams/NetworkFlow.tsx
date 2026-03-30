import React, { useState } from 'react';
import styles from './NetworkFlow.module.css';

const layers = [
  {
    id: 'client',
    label: 'Client',
    icon: '🌐',
    desc: '사용자 브라우저',
    detail: '사용자가 {subdomain}.dev.domain 으로 접속합니다.',
  },
  {
    id: 'cloudfront',
    label: 'CloudFront',
    icon: '🛡️',
    desc: 'CDN + WAF',
    detail: 'AWS WAF (Managed Rules + Rate Limiting) → CloudFront Distribution → TLS 1.2+ 종단, DDoS 방어 (Shield Standard).',
  },
  {
    id: 'alb',
    label: 'ALB',
    icon: '⚖️',
    desc: 'Load Balancer',
    detail: 'CloudFront Prefix List + X-Custom-Secret 헤더로 직접 접근 차단. HTTPS → NLB로 전달.',
  },
  {
    id: 'nlb',
    label: 'NLB',
    icon: '🔀',
    desc: 'Network LB',
    detail: 'Internal NLB — TCP passthrough로 Nginx Reverse Proxy 서비스에 연결. 크로스존 로드 밸런싱.',
  },
  {
    id: 'nginx',
    label: 'Nginx',
    icon: '📡',
    desc: 'Reverse Proxy',
    detail: 'ECS 서비스 (2 replicas HA). DynamoDB Stream → Lambda → S3 → Nginx 자동 설정 리로드. Host 기반 라우팅: {subdomain}.dev.domain → container IP:8080. WebSocket 지원 (3600s timeout).',
  },
  {
    id: 'ecs',
    label: 'ECS Task',
    icon: '📦',
    desc: 'code-server',
    detail: 'Per-user ECS Task (EC2 모드, awsvpc). code-server + Claude Code + Kiro. EFS Access Point로 파일 격리. Per-user IAM Role로 Bedrock 직접 호출.',
  },
];

export default function NetworkFlow() {
  const [active, setActive] = useState('cloudfront');

  const activeLayer = layers.find(l => l.id === active)!;

  return (
    <div className={styles.container}>
      <h3>네트워크 라우팅 아키텍처</h3>
      <p className={styles.subtitle}>각 계층을 클릭하여 상세 정보를 확인하세요.</p>

      <div className={styles.flow}>
        {layers.map((layer, i) => (
          <React.Fragment key={layer.id}>
            <div
              className={`${styles.node} ${active === layer.id ? styles.active : ''}`}
              onClick={() => setActive(layer.id)}
            >
              <div className={styles.icon}>{layer.icon}</div>
              <div className={styles.label}>{layer.label}</div>
              <div className={styles.desc}>{layer.desc}</div>
            </div>
            {i < layers.length - 1 && <div className={styles.arrow}>→</div>}
          </React.Fragment>
        ))}
      </div>

      <div className={styles.detailBox}>
        <h4>{activeLayer.icon} {activeLayer.label}</h4>
        <p>{activeLayer.detail}</p>
      </div>
    </div>
  );
}
