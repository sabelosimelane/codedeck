import React from 'react';

export default function BrandMark({ size = 32, showWordmark = false, showTagline = true, gap: gapOverride, stacked = false }) {
  const direction = stacked ? 'column' : 'row';
  const gap = gapOverride ?? (stacked ? 10 : 12);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: stacked ? 'flex-start' : 'center',
        flexDirection: direction,
        gap,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="codedeck-shell" x1="10" y1="10" x2="54" y2="56" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0F1722" />
            <stop offset="1" stopColor="#0A0D14" />
          </linearGradient>
          <linearGradient id="codedeck-accent" x1="16" y1="14" x2="52" y2="46" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8CF1D0" />
            <stop offset="0.52" stopColor="#43D7B2" />
            <stop offset="1" stopColor="#35BEEA" />
          </linearGradient>
        </defs>

        <rect x="8" y="8" width="48" height="48" rx="16" fill="url(#codedeck-shell)" />
        <rect x="8.5" y="8.5" width="47" height="47" rx="15.5" stroke="rgba(255,255,255,0.1)" />
        <path d="M20 23.5L30 17.5" stroke="url(#codedeck-accent)" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
        <path d="M21.5 31L31.5 25" stroke="url(#codedeck-accent)" strokeWidth="3" strokeLinecap="round" opacity="0.82" />
        <path d="M23 38.5L33 32.5" stroke="url(#codedeck-accent)" strokeWidth="3" strokeLinecap="round" />
        <path d="M37.5 23L31 31.5L37.5 40" stroke="url(#codedeck-accent)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M44.5 23L51 31.5L44.5 40" stroke="url(#codedeck-accent)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="47" cy="18" r="2" fill="#8CF1D0" opacity="0.9" />
      </svg>

      {showWordmark && (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="brand-wordmark">CodeDeck</span>
          {showTagline && <span className="brand-tagline">terminal workspace cockpit</span>}
        </div>
      )}
    </div>
  );
}
