import React, { useRef, useState } from 'react';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_TOTAL_BYTES, isSafeAttachmentName } from '../../../../shared/workflow-attachments.mjs';
import { Button, Field, Note } from '../ui/index.jsx';
import './RunWorkflowDialog.css';

function probeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = resolve;
    reader.onerror = reject;
    reader.onabort = reject;
    reader.readAsArrayBuffer(file.slice(0, 1));
  });
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export default function WorkflowAttachments({ entries, onChange, onChecking, disabled, primaryOnly }) {
  const [errors, setErrors] = useState([]);
  const [checking, setChecking] = useState(false);
  const [over, setOver] = useState(false);
  const checkingRef = useRef(false);
  const nextId = useRef(0);

  async function append(files) {
    if (disabled || checkingRef.current || files.length === 0) return;
    checkingRef.current = true;
    setChecking(true);
    onChecking(true);
    const next = [...entries];
    const rejected = [];
    let total = entries.reduce((sum, { file }) => sum + file.size, 0);
    try {
      for (const { file, directory } of files) {
        let reason;
        if (directory) reason = 'Folders cannot be attached.';
        else if (!(file instanceof File) || !isSafeAttachmentName(file.name)) reason = 'Use a valid file name.';
        else if (file.size > ATTACHMENT_MAX_BYTES) reason = 'Each file must be 20 MiB or smaller.';
        else if (next.length >= ATTACHMENT_MAX_COUNT) reason = 'You can attach up to 20 files.';
        else if (total + file.size > ATTACHMENT_MAX_TOTAL_BYTES) reason = 'Attachments must total 100 MiB or less.';
        else {
          try { await probeFile(file); } catch { reason = 'The file could not be read.'; }
        }
        if (reason) rejected.push(`${directory || file?.name || 'Unnamed file'}: ${reason}`);
        else {
          next.push({ file, id: nextId.current++ });
          total += file.size;
        }
      }
      onChange(next);
      setErrors(rejected);
    } finally {
      checkingRef.current = false;
      setChecking(false);
      onChecking(false);
    }
  }

  const unavailable = disabled || checking;
  return <Field label="Attach files" hint="Up to 20 files, 20 MiB each and 100 MiB total. The workflow agent can read them.">
    <div className="workflow-attachment-drop" data-over={over} role="group" aria-label="Drop workflow attachments" aria-disabled={unavailable}
      onDragOver={event => { event.preventDefault(); if (!unavailable) setOver(true); }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
      onDrop={event => {
        event.preventDefault();
        setOver(false);
        const items = Array.from(event.dataTransfer.items ?? []).filter(item => item.kind === 'file');
        const files = items.length ? items.map(item => {
          const entry = item.webkitGetAsEntry?.();
          return { file: item.getAsFile(), directory: entry?.isDirectory ? entry.name : null };
        }) : Array.from(event.dataTransfer.files, file => ({ file }));
        void append(files);
      }}>
      <input aria-label="Attach files" type="file" multiple disabled={unavailable} onChange={event => {
        const files = Array.from(event.target.files, file => ({ file }));
        event.target.value = '';
        void append(files);
      }} />
      <span className="ui-field-hint">or drop files here</span>
    </div>
    {checking && <span role="status" className="ui-field-hint">Checking files…</span>}
    {entries.length > 0 && <ol className="workflow-attachment-list" aria-label="Selected files">
      {entries.map(({ id, file }) => <li key={id}>
        <span className="workflow-attachment-name">{file.name}</span>
        <span className="ui-field-hint">{sizeLabel(file.size)}</span>
        <Button size="small" disabled={unavailable} aria-label={`Remove ${file.name}`} onClick={() => onChange(entries.filter(entry => entry.id !== id))}>Remove</Button>
      </li>)}
    </ol>}
    {errors.length > 0 && <Note tone="danger" role="alert"><ul>{errors.map((message, index) => <li key={index}>{message}</li>)}</ul></Note>}
    {primaryOnly && <span className="ui-field-hint">Attachments go to the primary run only.</span>}
  </Field>;
}
