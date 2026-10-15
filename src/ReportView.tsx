import { useState } from 'react';
import { Sev } from './Sev';
import { type Category, type Check, CATEGORIES, categoryOf, score } from './checks';

const tone = (s: number | null) => (s === null ? 'none' : s >= 85 ? 'good' : s >= 60 ? 'ok' : 'bad');

export function ScoreRing({ value, size = 112 }: { value: number | null; size?: number }) {
  const compact = size < 60;
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${tone(value)}`} width={size} height={size} viewBox="0 0 110 110" role="img" aria-label={value === null ? 'No score yet' : `Score ${value} out of 100`}>
      <circle cx="55" cy="55" r={r} className="track" />
      <circle cx="55" cy="55" r={r} className="value" strokeDasharray={`${((value ?? 0) / 100) * c} ${c}`} transform="rotate(-90 55 55)" />
      <text x="55" y={compact ? 68 : 53} textAnchor="middle" className={compact ? 'num compact' : 'num'}>
        {value ?? '–'}
      </text>
      {!compact && (
        <text x="55" y="72" textAnchor="middle" className="of">
          of 100
        </text>
      )}
    </svg>
  );
}

export function ReportView({ checks, connected, onExport }: { checks: Check[]; connected: boolean; onExport: () => void }) {
  const [only, setOnly] = useState<Category | null>(null);
  const sc = score(checks);
  if (!connected) return <p className="muted pad">Connect to see how ready your add-on is.</p>;
  const shown = checks.filter((c) => !only || categoryOf(c.id) === only);
  const order = { fail: 0, warn: 1, pass: 2, info: 3 } as const;
  return (
    <div className="report">
      <div className="score-head">
        <ScoreRing value={sc.overall} size={96} />
        <div className="parts">
          {sc.parts.map((p) => (
            <button key={p.category} className={`part ${tone(p.score)} ${only === p.category ? 'on' : ''}`} onClick={() => setOnly(only === p.category ? null : p.category)} disabled={p.score === null} title={p.score === null ? 'Nothing checked yet' : `${p.fail} to fix, ${p.warn} to improve`}>
              <span>{p.category}</span>
              <i style={{ width: `${p.score ?? 0}%` }} />
              <b>{p.score ?? '–'}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="report-bar">
        <span className="muted small">{only ? `${only} only · ` : ''}{shown.filter((c) => c.level === 'fail').length} to fix · {shown.filter((c) => c.level === 'warn').length} to improve · {shown.filter((c) => c.level === 'pass').length} good</span>
        <button className="small-btn" onClick={onExport}>
          Copy as Markdown
        </button>
      </div>
      {CATEGORIES.filter((cat) => !only || cat === only).map((cat) => {
        const mine = shown.filter((c) => categoryOf(c.id) === cat).sort((a, b) => order[a.level] - order[b.level]);
        if (!mine.length) return null;
        return (
          <section key={cat} className="check-group">
            <h3>{cat}</h3>
            {mine.map((c) => (
              <details key={c.id} className={`check-row ${c.level}`} open={c.level === 'fail'}>
                <summary>
                  <Sev level={c.level} />
                  <b>{c.title}</b>
                </summary>
                {c.detail && <p>{c.detail}</p>}
                {c.tools && c.tools.length > 0 && <p className="tools-list">{c.tools.join(' · ')}</p>}
              </details>
            ))}
          </section>
        );
      })}
      {sc.parts.find((p) => p.category === 'Robustness')?.score === null && <p className="muted small hint">Run the robustness tests (Tests tab) to score how your server handles mistakes.</p>}
      {sc.parts.find((p) => p.category === 'Voice')?.score === null && <p className="muted small hint">Run a tool, or talk to your add-on, to score its replies.</p>}
      <p className="muted small note">This project's own checklist: the MCP spec (2025-11-25), the MCP Apps extension, WCAG, and voice rules of thumb. Not an Amazon certification.</p>
    </div>
  );
}
