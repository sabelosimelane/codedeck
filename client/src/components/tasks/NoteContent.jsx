import React, { useMemo } from 'react';
import { parseNote } from '../../utils/noteMarkdown.js';

const runs = inline => inline.map((run, index) => (
  run.code ? <code key={index}>{run.text}</code> : run.bold ? <strong key={index}>{run.text}</strong> : <React.Fragment key={index}>{run.text}</React.Fragment>
));

/** A step note as a readable document: headings, lists, paragraphs and code. */
export default function NoteContent({ content }) {
  const blocks = useMemo(() => parseNote(content), [content]);
  return (
    <div className="task-note">
      {blocks.map((block, index) => {
        if (block.type === 'heading') return <h4 key={index} className="task-note-heading" data-level={Math.min(block.level, 3)}>{runs(block.inline)}</h4>;
        if (block.type === 'code') return <pre key={index} className="task-note-code">{block.text}</pre>;
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return <List key={index} className="task-note-list">{block.items.map((item, position) => <li key={position}>{runs(item)}</li>)}</List>;
        }
        return <p key={index} className="task-note-paragraph">{runs(block.inline)}</p>;
      })}
    </div>
  );
}
