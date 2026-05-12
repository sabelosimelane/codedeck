import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, FileCode2, Minus, Plus, RefreshCw, X } from 'lucide-react';
import mermaid from 'mermaid';
import { renderMarkdownToHtml } from '../utils/markdownPreview';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
});

const MERMAID_MIN_ZOOM = 0.6;
const MERMAID_MAX_ZOOM = 2.4;
const MERMAID_ZOOM_STEP = 0.2;

function roundZoom(value) {
  return Math.round(value * 100) / 100;
}

function getMermaidSvgMetrics(svg) {
  const viewBox = svg.viewBox?.baseVal;
  const width = viewBox?.width || svg.width?.baseVal?.value || svg.getBoundingClientRect().width;
  const height = viewBox?.height || svg.height?.baseVal?.value || svg.getBoundingClientRect().height;
  return { width, height };
}

export default function PreviewPage({ filePath, onOpenFile }) {
  const [preview, setPreview] = useState({ state: 'loading' });
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [activeMermaid, setActiveMermaid] = useState(null);
  const [isPanningLightbox, setIsPanningLightbox] = useState(false);
  const lightboxDiagramRef = useRef(null);
  const lightboxViewportRef = useRef(null);
  const panStateRef = useRef(null);
  const lightboxZoomRef = useRef(1);
  const pendingLightboxScrollRef = useRef(null);

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
    setLightboxZoom(1);
    setActiveMermaid(null);
    setIsPanningLightbox(false);
    panStateRef.current = null;
    lightboxZoomRef.current = 1;
    pendingLightboxScrollRef.current = null;
  }, [filePath]);

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
    if (preview.state === 'ready' && (preview.format === 'markdown' || preview.format === 'mermaid')) {
      const timer = setTimeout(() => {
        mermaid.run({
          querySelector: '.mermaid',
        }).catch(err => console.error('Mermaid render error:', err));
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [preview]);

  useEffect(() => {
    lightboxZoomRef.current = lightboxZoom;

    if (!activeMermaid) return;

    const svg = lightboxDiagramRef.current?.querySelector('svg');
    if (!svg) return;

    svg.setAttribute('width', `${activeMermaid.width}`);
    svg.setAttribute('height', `${activeMermaid.height}`);
    svg.style.width = `${activeMermaid.width}px`;
    svg.style.height = `${activeMermaid.height}px`;
    svg.style.maxWidth = 'none';
    svg.style.transformOrigin = 'top left';
    svg.style.transform = `scale(${lightboxZoom})`;

    const pendingScroll = pendingLightboxScrollRef.current;
    const viewport = lightboxViewportRef.current;
    if (pendingScroll && viewport) {
      viewport.scrollLeft = pendingScroll.left;
      viewport.scrollTop = pendingScroll.top;
      pendingLightboxScrollRef.current = null;
    }
  }, [activeMermaid, lightboxZoom]);

  useEffect(() => {
    if (!activeMermaid) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setActiveMermaid(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeMermaid]);

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

  const openMermaidLightbox = (mermaidElement) => {
    const svg = mermaidElement?.querySelector('svg');
    if (!svg) return;

    const { width, height } = getMermaidSvgMetrics(svg);
    if (!(width > 0 && height > 0)) return;

    setLightboxZoom(1);
    setActiveMermaid({
      markup: svg.outerHTML,
      width,
      height,
    });
  };

  const handleMarkdownBodyClick = (event) => {
    const mermaidElement = event.target.closest('.mermaid');
    if (!mermaidElement) return;
    openMermaidLightbox(mermaidElement);
  };

  const handleLightboxPointerDown = (event) => {
    if (!lightboxViewportRef.current || event.button !== 0) return;

    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: lightboxViewportRef.current.scrollLeft,
      scrollTop: lightboxViewportRef.current.scrollTop,
    };
    setIsPanningLightbox(true);
  };

  const handleLightboxPointerMove = (event) => {
    if (!lightboxViewportRef.current || !panStateRef.current) return;

    const deltaX = event.clientX - panStateRef.current.startX;
    const deltaY = event.clientY - panStateRef.current.startY;

    lightboxViewportRef.current.scrollLeft = panStateRef.current.scrollLeft - deltaX;
    lightboxViewportRef.current.scrollTop = panStateRef.current.scrollTop - deltaY;
  };

  const handleLightboxWheel = (event) => {
    if (!activeMermaid || (!event.metaKey && !event.ctrlKey) || !lightboxViewportRef.current) return;

    event.preventDefault();

    const currentZoom = lightboxZoomRef.current;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZoom = Math.min(
      MERMAID_MAX_ZOOM,
      Math.max(MERMAID_MIN_ZOOM, roundZoom(currentZoom + (direction * MERMAID_ZOOM_STEP))),
    );

    if (nextZoom === currentZoom) return;

    const viewport = lightboxViewportRef.current;
    const rect = viewport.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const baseX = (viewport.scrollLeft + offsetX) / currentZoom;
    const baseY = (viewport.scrollTop + offsetY) / currentZoom;

    pendingLightboxScrollRef.current = {
      left: Math.max(0, (baseX * nextZoom) - offsetX),
      top: Math.max(0, (baseY * nextZoom) - offsetY),
    };

    setLightboxZoom(nextZoom);
  };

  const stopLightboxPanning = () => {
    panStateRef.current = null;
    setIsPanningLightbox(false);
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
            onClick={handleMarkdownBodyClick}
            dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(preview.content) }}
          />
        </div>
      );
    }

    if (preview.format === 'mermaid') {
      return (
        <div style={markdownFrameStyle}>
          <div style={mermaidViewportStyle}>
            <div
              className="mermaid-preview-trigger"
              style={mermaidCanvasStyle}
              onClick={(event) => openMermaidLightbox(event.currentTarget)}
            >
              <div className="mermaid mermaid-preview-diagram" style={mermaidDiagramStyle}>
                {preview.content}
              </div>
            </div>
          </div>
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
            <button type="button" style={secondaryBtnStyle} onClick={() => window.location.reload()} title="Refresh preview">
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
              title="Copy preview content"
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
              title="Download preview content"
            >
              <Download size={14} />
              <span>Download</span>
            </button>
            <button type="button" style={primaryBtnStyle} onClick={() => onOpenFile(filePath)} title="Open in editor">
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
                  : preview.format === 'mermaid'
                    ? 'Mermaid diagram'
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

      {activeMermaid && (
        <div style={lightboxOverlayStyle} onClick={() => setActiveMermaid(null)} onMouseUp={stopLightboxPanning}>
          <div style={lightboxPanelStyle} onClick={(event) => event.stopPropagation()}>
            <div style={lightboxToolbarStyle}>
              <div style={zoomPillStyle}>{Math.round(lightboxZoom * 100)}%</div>
              <button
                type="button"
                style={{
                  ...secondaryBtnStyle,
                  ...(lightboxZoom <= MERMAID_MIN_ZOOM ? disabledBtnStyle : null),
                }}
                onClick={() => setLightboxZoom((value) => Math.max(MERMAID_MIN_ZOOM, roundZoom(value - MERMAID_ZOOM_STEP)))}
                disabled={lightboxZoom <= MERMAID_MIN_ZOOM}
                title="Zoom out"
              >
                <Minus size={14} />
                <span>Zoom out</span>
              </button>
              <button
                type="button"
                style={{
                  ...secondaryBtnStyle,
                  ...(lightboxZoom >= MERMAID_MAX_ZOOM ? disabledBtnStyle : null),
                }}
                onClick={() => setLightboxZoom((value) => Math.min(MERMAID_MAX_ZOOM, roundZoom(value + MERMAID_ZOOM_STEP)))}
                disabled={lightboxZoom >= MERMAID_MAX_ZOOM}
                title="Zoom in"
              >
                <Plus size={14} />
                <span>Zoom in</span>
              </button>
              <button
                type="button"
                style={{
                  ...secondaryBtnStyle,
                  ...(lightboxZoom === 1 ? disabledBtnStyle : null),
                }}
                onClick={() => setLightboxZoom(1)}
                disabled={lightboxZoom === 1}
                title="Reset zoom"
              >
                <span>Reset zoom</span>
              </button>
              <button type="button" style={secondaryBtnStyle} onClick={() => setActiveMermaid(null)} title="Close diagram preview">
                <X size={14} />
                <span>Close</span>
              </button>
            </div>
            <div
              ref={lightboxViewportRef}
              style={{
                ...lightboxViewportStyle,
                cursor: isPanningLightbox ? 'grabbing' : 'grab',
              }}
              onMouseDown={handleLightboxPointerDown}
              onMouseMove={handleLightboxPointerMove}
              onMouseUp={stopLightboxPanning}
              onMouseLeave={stopLightboxPanning}
              onWheel={handleLightboxWheel}
            >
              <div
                style={{
                  ...lightboxCanvasStyle,
                  width: activeMermaid.width * lightboxZoom,
                  height: activeMermaid.height * lightboxZoom,
                }}
              >
                <div ref={lightboxDiagramRef} dangerouslySetInnerHTML={{ __html: activeMermaid.markup }} />
              </div>
            </div>
          </div>
        </div>
      )}
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

const zoomPillStyle = {
  ...metaPillStyle,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 74,
  height: 38,
  padding: '0 12px',
  color: 'var(--text-primary)',
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

const mermaidViewportStyle = {
  overflow: 'auto',
  padding: '8px 0 20px',
};

const mermaidCanvasStyle = {
  minHeight: 220,
  margin: '0 auto',
  width: 'fit-content',
};

const mermaidDiagramStyle = {
  display: 'inline-block',
};

const lightboxOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'center',
  padding: 24,
  background: 'rgba(4, 8, 12, 0.82)',
  backdropFilter: 'blur(8px)',
};

const lightboxPanelStyle = {
  width: 'min(1400px, 100%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 20,
  padding: 18,
  background: 'rgba(16, 19, 26, 0.96)',
  boxShadow: 'var(--shadow-soft)',
};

const lightboxToolbarStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  justifyContent: 'flex-end',
};

const lightboxViewportStyle = {
  flex: 1,
  overflow: 'auto',
  borderRadius: 16,
  border: '1px solid rgba(255, 255, 255, 0.06)',
  background: 'rgba(0, 0, 0, 0.26)',
  padding: 20,
};

const lightboxCanvasStyle = {
  margin: '0 auto',
  minWidth: 'fit-content',
  minHeight: 'fit-content',
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
