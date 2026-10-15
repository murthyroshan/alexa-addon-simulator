import { useState } from 'react';
import { AppFrame, type DisplayMode } from './AppFrame';
import { DEVICES, type DeviceKey } from './Device';
import type { ToolResult, Traffic } from './mcp';
import { MIN_TEXT_PX, type ProbeMetrics } from './probe';

/** The same card on every Echo screen at once, each with what the audit measured there. */
export function Compare(props: {
  html: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  mode: DisplayMode;
  theme: 'dark' | 'light';
  locale: string;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onTraffic: (t: Omit<Traffic, 'id'>) => void;
  onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<Partial<Record<DeviceKey, ProbeMetrics>>>({});
  const keys = Object.keys(DEVICES) as DeviceKey[];
  return (
    <div className="compare" role="dialog" aria-label="Compare screens">
      <div className="compare-head">
        <div>
          <h2>Your card on every Echo screen</h2>
          <p className="muted">
            {props.tool} · {props.mode === 'fullscreen' ? 'full screen' : 'inline'} · {props.theme}
          </p>
        </div>
        <button className="small-btn" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="compare-grid">
        {keys.map((k) => {
          const d = DEVICES[k];
          const m = metrics[k];
          const scale = Math.min(300 / d.width, 260 / d.height);
          const total = m ? Object.values(m.textBySize).reduce((a, b) => a + b, 0) : 0;
          const small = m ? Object.entries(m.textBySize).filter(([s]) => Number(s) < MIN_TEXT_PX).reduce((a, [, n]) => a + n, 0) : 0;
          const fits = m ? (props.mode === 'fullscreen' ? m.overflow.y <= 4 && m.overflow.x <= 4 : m.overflow.x <= 4) : null;
          return (
            <figure key={k} className="mini">
              <div className="mini-bezel" style={{ width: d.width * scale + 12, height: d.height * scale + 12 }}>
                <div className="mini-screen" style={{ width: d.width, height: d.height, transform: `scale(${scale})` }}>
                  <div className={`os ${props.theme}`}>
                    <div className={`card-slot ${props.mode}`}>
                      <AppFrame
                        html={props.html}
                        toolName={props.tool}
                        toolInput={props.args}
                        toolResult={props.result}
                        displayMode={props.mode}
                        device={d}
                        theme={props.theme}
                        locale={props.locale}
                        onProbe={(pm) => setMetrics((all) => ({ ...all, [k]: pm }))}
                        onDisplayMode={() => {}}
                        onToolCall={props.onToolCall}
                        onUserMessage={() => {}}
                        onOpenLink={() => {}}
                        onTraffic={props.onTraffic}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <figcaption>
                <b>{d.label}</b>
                <span className="muted">
                  {d.width} × {d.height}
                </span>
                {m ? (
                  <span className="badges">
                    <em className={fits ? 'ok' : 'bad'}>{fits ? 'Fits' : `${m.overflow.y || m.overflow.x} px over`}</em>
                    <em className={total && small / total > 0.25 ? 'warn' : 'ok'}>{total ? `${Math.round((1 - small / total) * 100)}% readable` : 'No text'}</em>
                    {m.smallTargets.length > 0 && <em className="warn">{m.smallTargets.length} small targets</em>}
                  </span>
                ) : (
                  <span className="badges">
                    <em>Measuring…</em>
                  </span>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
