// Where the seconds go: every turn (a sentence, or a tool run) as a waterfall of its parts, and
// every tool call's time as a sparkline.

export interface Segment {
  kind: 'model' | 'tool' | 'wait' | 'speech' | 'card';
  label: string;
  start: number;
  end: number;
}

export interface RunRecord {
  id: number;
  kind: 'talk' | 'tool';
  label: string;
  start: number;
  segments: Segment[];
}

const KIND_LABEL: Record<Segment['kind'], string> = { model: 'Model', tool: 'Your server', wait: 'The person', speech: 'Speaking', card: 'Card' };

export const totalOf = (r: RunRecord) => (r.segments.length ? Math.max(...r.segments.map((s) => s.end)) - r.start : 0);
/** Time spent in the server only (overlapping calls counted once). */
export const serverTimeOf = (r: RunRecord) => r.segments.filter((s) => s.kind === 'tool').reduce((sum, s) => sum + (s.end - s.start), 0);

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

export function Waterfall({ run }: { run: RunRecord }) {
  const total = Math.max(totalOf(run), 1);
  return (
    <div className="waterfall">
      <div className="wf-head">
        <b>{run.kind === 'talk' ? `“${run.label}”` : run.label}</b>
        <span>{fmt(total)}</span>
      </div>
      {run.segments.map((s, i) => (
        <div key={i} className={`wf-row ${s.kind}`}>
          <span className="wf-label" title={s.label}>
            {KIND_LABEL[s.kind]} <em>{s.label}</em>
          </span>
          <span className="wf-track">
            <i style={{ left: `${((s.start - run.start) / total) * 100}%`, width: `${Math.max(((s.end - s.start) / total) * 100, 0.8)}%` }} />
          </span>
          <span className="wf-ms">{fmt(s.end - s.start)}</span>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ values, width = 140, height = 30 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Recent tool times, up to ${fmt(max)}`}>
      <polyline points={`0,${height} ${pts} ${width},${height}`} className="fill" />
      <polyline points={pts} className="line" />
    </svg>
  );
}

export { fmt as formatMs };
