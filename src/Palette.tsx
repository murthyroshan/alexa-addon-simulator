import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  run: () => void;
}

/** Ctrl+K: every tool and action, by typing. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w))).slice(0, 12);
  }, [q, commands]);
  useEffect(() => setAt(0), [q]);
  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Run a tool, switch device, run tests…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAt((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAt((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') go(shown[at]);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul>
          {shown.map((c, i) => (
            <li key={c.id}>
              <button className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => go(c)}>
                <Icon name={c.icon ?? 'spark'} />
                <span>{c.label}</span>
                {c.hint && <em>{c.hint}</em>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
