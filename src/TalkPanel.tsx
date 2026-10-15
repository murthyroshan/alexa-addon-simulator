import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MODELS, type ModelSettings, type Provider } from './assistant';

export type Line = { id: number } & ({ who: 'you' | 'alexa'; text: string } | { who: 'step'; name: string; ms: number; ok: boolean; note?: string } | { who: 'error'; text: string });

const SUGGESTIONS = ['What can you do?', 'Show me what you have', 'Help me get started'];

export function TalkPanel(props: {
  lines: Line[];
  settings: ModelSettings;
  onSettings: (s: ModelSettings) => void;
  onSend: (text: string) => void;
  busy: boolean;
  canListen: boolean;
  listening: boolean;
  interim: string;
  onMic: () => void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(!props.settings.apiKey && props.settings.provider === 'gemini');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [props.lines.length, props.interim]);
  const { settings } = props;
  const ready = Boolean(settings.apiKey) || (settings.provider === 'openai' && Boolean(settings.baseUrl));
  const set = (patch: Partial<ModelSettings>) => props.onSettings({ ...settings, ...patch });
  const send = (t: string) => {
    if (!t.trim() || props.busy || !ready) return;
    props.onSend(t.trim());
    setText('');
  };
  return (
    <div className="talk">
      <details className="model" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span>Assistant model</span>
          <em className={ready ? 'ok' : ''}>{ready ? `${settings.provider === 'gemini' ? 'Gemini' : 'OpenAI-compatible'} · ${settings.model}` : 'Add a key to talk'}</em>
        </summary>
        <div className="model-body">
          <div className="seg small">
            {(['gemini', 'openai'] as Provider[]).map((p) => (
              <button key={p} type="button" className={settings.provider === p ? 'on' : ''} onClick={() => set({ provider: p, model: DEFAULT_MODELS[p] })}>
                {p === 'gemini' ? 'Gemini' : 'OpenAI-compatible'}
              </button>
            ))}
          </div>
          {settings.provider === 'openai' && (
            <label className="field">
              <span>Base URL</span>
              <input value={settings.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1 · http://localhost:11434/v1" spellCheck={false} />
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <input value={settings.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
          </label>
          <label className="field">
            <span>API key</span>
            <input type="password" value={settings.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={settings.provider === 'gemini' ? 'From Google AI Studio' : 'Not needed for a local model'} autoComplete="off" spellCheck={false} />
          </label>
          <p className="muted small">The key stays in this browser and goes only to the model you chose. The assistant plays Alexa+: it picks your tools by their descriptions, exactly as a real assistant has to.</p>
        </div>
      </details>

      <div className="transcript" aria-live="polite">
        {props.lines.length === 0 && (
          <div className="talk-empty">
            <p>Say or type what someone would say to Alexa. The assistant chooses your tools, your card appears on the screen, and the reply is spoken.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={!ready || props.busy} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.lines.map((l) =>
          l.who === 'step' ? (
            <div key={l.id} className={`step ${l.ok ? '' : 'bad'}`}>
              <span className="tool-chip">{l.name}</span>
              <span>{l.ok ? `${Math.round(l.ms)} ms` : 'failed'}</span>
              {l.note && <em>{l.note}</em>}
            </div>
          ) : (
            <div key={l.id} className={`bubble ${l.who}`}>
              {l.text}
            </div>
          ),
        )}
        {props.interim && <div className="bubble you interim">{props.interim}…</div>}
        {props.busy && !props.interim && (
          <div className="bubble alexa typing" aria-label="Thinking">
            <i />
            <i />
            <i />
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        {props.canListen && (
          <button type="button" className={`mic ${props.listening ? 'on' : ''}`} onClick={props.onMic} disabled={!ready || props.busy} aria-label={props.listening ? 'Stop listening' : 'Speak'}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        )}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={ready ? 'Alexa, …' : 'Add a model key above to talk'} disabled={!ready} />
        <button className="primary" disabled={!ready || props.busy || !text.trim()}>
          Say
        </button>
      </form>
    </div>
  );
}
