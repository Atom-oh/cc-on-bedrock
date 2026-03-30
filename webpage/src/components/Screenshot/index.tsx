import React from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';

interface Props {
  src: string;
  alt: string;
  caption?: string;
}

export default function Screenshot({ src, alt, caption }: Props) {
  const imgSrc = useBaseUrl(src);
  return (
    <div style={{ margin: '2rem 0', textAlign: 'center' }}>
      <div style={{
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
        border: '1px solid var(--ifm-color-emphasis-200)',
        lineHeight: 0
      }}>
        <img src={imgSrc} alt={alt} style={{ width: '100%', height: 'auto', display: 'block' }} />
      </div>
      {caption && (
        <p style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--ifm-color-emphasis-600)',
          fontStyle: 'italic'
        }}>
          {caption}
        </p>
      )}
    </div>
  );
}
