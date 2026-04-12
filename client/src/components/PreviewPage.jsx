import React, { useEffect, useState } from 'react';
import { Copy, Download, ExternalLink, FileCode2, RefreshCw } from 'lucide-react';
import { renderMarkdownToHtml } from '../utils/markdownPreview';

export default function PreviewPage({ filePath, onOpenFile }) {
  const [preview, setPreview] = useState({ state: 'loading' });

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      rootOverflow: root?.style.overflow || '',
    };

    html.style.overflow = 'auto';
    body.style.overflow = 'auto';
    if (root) root.style.overflow = 'visible';

    return () => {
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      if (root) root.style.overflow = previous.rootOverflow;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      try {
        const res = await fetch(`/api/file-preview?filePath=${encodeURIComponent(filePath)}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || 'Failed to load file preview');
        }

        if (!cancelled) {
          setPreview({ state: 'ready', ...data });
        }
      } catch (error) {
        if (!cancelled) {
          setPreview({ state: 'error', message: error.message });
        }
      }
    };

    setPreview({ state: 'loading' });
    loadPreview();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    const fileName = filePath.split('/').pop() || 'Preview';
    document.title = `${fileName} · CodeDeck Preview`;
  }, [filePath]);

  const handleCopy = async () => {
    if (preview.state !== 'ready' || preview.kind !== 'text') return;
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(preview.content);
  };

  const handleDownload = () => {
    if (preview.state !== 'ready' || preview.kind !== 'text') return;

    const blob = new Blob([preview.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filePath.split('/').pop() || 'preview.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const renderBody = () => {
    if (preview.state === 'loading') {
      return <div style={emptyStateStyle}>Loading preview…</div>;
    }

    if (preview.state === 'error') {
      return <div style={emptyStateStyle}>{preview.message}</div>;
    }

    if (preview.kind !== 'text') {
      return (
        <div style={emptyStateStyle}>
          Browser preview is currently limited to text-based files.
        </div>
      );
    }

    if (preview.format === 'markdown') {
      return (
        <div style={markdownFrameStyle}>
          <article
            style={markdownArticleStyle}
            className="markdown-preview"
            dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(preview.content) }}
          />
        </div>
      );
    }

    const lines = preview.content.split('\n');

    return (
      <div style={codeFrameStyle}>
        <div style={codeScrollStyle}>
          <table style={codeTableStyle}>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td style={lineNumberStyle}>{index + 1}</td>
                  <td style={lineContentStyle}>
                    <pre style={preStyle}>{line || ' '}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div style={pageStyle}>
      <div style={ambientGlowStyle} />
      <div style={stickyRailStyle}>
        <header style={headerStyle}>
          <div style={titleGroupStyle}>
            <div style={iconWrapStyle}>
              <FileCode2 size={18} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={eyebrowStyle}>Browser Preview</div>
              <h1 style={titleStyle}>{filePath.split('/').pop() || filePath}</h1>
              <div style={pathStyle}>{filePath}</div>
            </div>
          </div>
          <div style={actionsStyle}>
            <button type="button" style={secondaryBtnStyle} onClick={() => window.location.reload()}>
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              style={{
                ...secondaryBtnStyle,
                ...(preview.state !== 'ready' || preview.kind !== 'text' ? disabledBtnStyle : null),
              }}
              onClick={handleCopy}
              disabled={preview.state !== 'ready' || preview.kind !== 'text'}
            >
              <Copy size={14} />
              <span>Copy</span>
            </button>
            <button
              type="button"
              style={{
                ...secondaryBtnStyle,
                ...(preview.state !== 'ready' || preview.kind !== 'text' ? disabledBtnStyle : null),
              }}
              onClick={handleDownload}
              disabled={preview.state !== 'ready' || preview.kind !== 'text'}
            >
              <Download size={14} />
              <span>Download</span>
            </button>
            <button type="button" style={primaryBtnStyle} onClick={() => onOpenFile(filePath)}>
              <ExternalLink size={14} />
              <span>Open in editor</span>
            </button>
          </div>
        </header>

        <section style={metaBarStyle}>
          <div style={metaPillStyle}>
            {preview.state === 'ready'
              ? preview.kind === 'text'
                ? preview.format === 'markdown'
                  ? 'Markdown file'
                  : 'Text file'
                : 'Binary file'
              : 'Preparing preview'}
          </div>
          {preview.state === 'ready' && (
            <div style={metaPillStyle}>{Math.max(1, Math.ceil((preview.size || 0) / 1024))} KB</div>
          )}
          {preview.state === 'ready' && preview.truncated && (
            <div style={warningPillStyle}>Preview trimmed to first 256 KB</div>
          )}
        </section>
      </div>

      <main style={contentShellStyle}>{renderBody()}</main>
    </div>
  );
}

const pageStyle = {
  minHeight: '100vh',
  padding: '28px',
  background:
    'radial-gradient(circle at top right, rgba(53, 190, 234, 0.10), transparent 26%), radial-gradient(circle at top left, rgba(95, 224, 186, 0.10), transparent 22%), var(--bg-base)',
  color: 'var(--text-primary)',
};

const ambientGlowStyle = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 24%)',
};

const stickyRailStyle = {
  position: 'sticky',
  top: 0,
  zIndex: 4,
  paddingTop: 4,
  marginBottom: 18,
};

const headerStyle = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  justifyContent: 'space-between',
  gap: 20,
  alignItems: 'flex-start',
  padding: '24px 28px',
  border: '1px solid var(--border)',
  borderRadius: 20,
  background: 'rgba(16, 19, 26, 0.82)',
  boxShadow: 'var(--shadow-soft)',
  backdropFilter: 'blur(14px)',
};

const titleGroupStyle = {
  minWidth: 0,
  display: 'flex',
  gap: 16,
};

const iconWrapStyle = {
  width: 42,
  height: 42,
  borderRadius: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(180deg, rgba(95, 224, 186, 0.18), rgba(53, 190, 234, 0.12))',
  color: 'var(--accent)',
  flexShrink: 0,
};

const eyebrowStyle = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  marginBottom: 8,
};

const titleStyle = {
  fontSize: 'clamp(22px, 4vw, 32px)',
  lineHeight: 1.05,
  letterSpacing: '-0.04em',
  marginBottom: 8,
};

const pathStyle = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const actionsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  justifyContent: 'flex-end',
};

const buttonBaseStyle = {
  height: 38,
  padding: '0 14px',
  borderRadius: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  transition: 'transform 120ms ease, border-color 120ms ease, background 120ms ease',
};

const secondaryBtnStyle = {
  ...buttonBaseStyle,
  color: 'var(--text-secondary)',
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid var(--border)',
};

const primaryBtnStyle = {
  ...buttonBaseStyle,
  color: '#08110f',
  background: 'linear-gradient(135deg, var(--accent), #7ee7d1)',
  border: '1px solid rgba(95, 224, 186, 0.6)',
};

const disabledBtnStyle = {
  opacity: 0.45,
  cursor: 'not-allowed',
};

const metaBarStyle = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  marginTop: 12,
  padding: '0 10px 2px',
};

const metaPillStyle = {
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'rgba(255, 255, 255, 0.03)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-secondary)',
};

const warningPillStyle = {
  ...metaPillStyle,
  color: 'var(--accent)',
  borderColor: 'rgba(95, 224, 186, 0.28)',
  background: 'rgba(95, 224, 186, 0.1)',
};

const contentShellStyle = {
  position: 'relative',
  zIndex: 1,
  border: '1px solid var(--border)',
  borderRadius: 20,
  overflow: 'hidden',
  background: 'rgba(16, 19, 26, 0.88)',
  boxShadow: 'var(--shadow-soft)',
};

const emptyStateStyle = {
  minHeight: '60vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 40,
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
};

const codeFrameStyle = {
  minHeight: '60vh',
  paddingTop: 14,
  paddingBottom: 10,
  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(0, 0, 0, 0.08))',
};

const markdownFrameStyle = {
  minHeight: '60vh',
  padding: '36px clamp(20px, 4vw, 52px) 56px',
  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(0, 0, 0, 0.08))',
};

const markdownArticleStyle = {
  maxWidth: 860,
  margin: '0 auto',
  lineHeight: 1.7,
  fontSize: 16,
  color: 'var(--text-primary)',
  wordBreak: 'break-word',
};

const codeScrollStyle = {
  overflow: 'auto',
};

const codeTableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
};

const lineNumberStyle = {
  width: 56,
  padding: '0 16px',
  verticalAlign: 'top',
  textAlign: 'right',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  borderRight: '1px solid rgba(255, 255, 255, 0.04)',
  userSelect: 'none',
};

const lineContentStyle = {
  padding: '0 18px',
  verticalAlign: 'top',
};

const preStyle = {
  margin: 0,
  minHeight: 22,
  lineHeight: 1.6,
  fontSize: 12.5,
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
