import React, { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * The actions of a landing bar that are not its next step, behind one button. An item the
 * backend refuses stays listed, disabled, with the reason under it, so the owner learns why
 * without hovering. Closes on Escape, on a click outside and once an item is chosen.
 *
 * `items`: `{ key, label, name?, disabledReason?, tone?, onSelect }`; `name` is the accessible
 * name when the label alone would be ambiguous (it must contain the label).
 */
export default function LandingMenu({ label, items, disabled = false }) {
  if (typeof label !== 'string' || label.trim() === '') throw new Error('landing menu: label is required');
  if (!Array.isArray(items)) throw new Error('landing menu: items must be an array');
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    const onPointer = (event) => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onPointer); };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div ref={root} className="landing-menu">
      <button type="button" className="landing-menu-trigger" aria-label={label} title={label} aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className="landing-menu-list">
          {items.map(item => (
            <button key={item.key} type="button" role="menuitem" className="landing-menu-item" data-tone={item.tone ?? 'plain'}
              aria-label={item.name ?? item.label} disabled={Boolean(item.disabledReason)}
              onClick={() => { setOpen(false); item.onSelect(); }}>
              <span>{item.label}</span>
              {item.disabledReason && <span className="landing-menu-reason">{item.disabledReason}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
