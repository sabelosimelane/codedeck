import React, { useCallback } from 'react';

export default function PaneDivider({ onDrag, onDoubleClick }) {
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    let lastX = e.clientX;

    const onMouseMove = (moveEvent) => {
      const delta = moveEvent.clientX - lastX;
      lastX = moveEvent.clientX;
      onDrag(delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onDrag]);

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
      className="pane-divider"
      style={{
        width: 4,
        cursor: 'col-resize',
        flexShrink: 0,
      }}
    />
  );
}
