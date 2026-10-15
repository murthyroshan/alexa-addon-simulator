import { useMemo, useState } from 'react';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { encode } from 'uqr';
import { argsOf, fieldsOf } from './schema';

type Params = ElicitRequest['params'];

/**
 * The server asking the person in front of the device (MCP elicitation): a short form on the
 * screen, or a link to open on their phone (URL mode: payments, sign-ins, anything that must not
 * happen on a shared screen).
 */
export function Elicit({ params, onDone }: { params: Params; onDone: (r: ElicitResult) => void }) {
  if (params.mode === 'url') return <UrlAsk params={params as Extract<Params, { mode: 'url' }>} onDone={onDone} />;
  return <FormAsk params={params as Extract<Params, { requestedSchema: unknown }>} onDone={onDone} />;
}

function UrlAsk({ params, onDone }: { params: Extract<Params, { mode: 'url' }>; onDone: (r: ElicitResult) => void }) {
  const host = (() => {
    try {
      return new URL(params.url).host;
    } catch {
      return params.url;
    }
  })();
  return (
    <div className="overlay ask" role="dialog" aria-label="Open on your phone">
      <div className="ask-card url">
        <Qr text={params.url} />
        <div>
          <p className="eyebrow">Finish on your phone</p>
          <h2>{params.message}</h2>
          <p className="muted">Scan, or open {host}</p>
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                window.open(params.url, '_blank', 'noopener');
                onDone({ action: 'accept' });
              }}
            >
              Open the link
            </button>
            <button onClick={() => onDone({ action: 'decline' })}>Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormAsk({ params, onDone }: { params: Extract<Params, { requestedSchema: unknown }>; onDone: (r: ElicitResult) => void }) {
  const fields = useMemo(() => fieldsOf(params.requestedSchema), [params.requestedSchema]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial])));
  const { args, errors } = argsOf(fields, values);
  const blocked = Object.keys(errors).length > 0;
  return (
    <div className="overlay ask" role="dialog" aria-label={params.message}>
      <form
        className="ask-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onDone({ action: 'accept', content: args as ElicitResult['content'] });
        }}
      >
        <p className="eyebrow">Alexa needs to know</p>
        <h2>{params.message}</h2>
        {fields.map((f, i) => (
          <label key={f.key} className="field">
            <span>
              {f.label}
              {f.required ? '' : ' (optional)'}
            </span>
            {f.kind === 'choice' || f.kind === 'boolean' ? (
              <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                {!f.required && <option value="">—</option>}
                {(f.kind === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus={i === 0}
                type={f.kind === 'number' || f.kind === 'integer' ? 'number' : 'text'}
                value={values[f.key]}
                placeholder={f.description}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        <div className="row">
          <button type="submit" className="primary" disabled={blocked}>
            Done
          </button>
          <button type="button" onClick={() => onDone({ action: 'cancel' })}>
            Cancel
          </button>
          <button type="button" className="ghost" onClick={() => onDone({ action: 'decline' })}>
            Decline
          </button>
        </div>
      </form>
    </div>
  );
}

export function Qr({ text }: { text: string }) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'L', border: 0 });
    let path = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x} ${y}h1v1h-1z`)));
    return { d: path, n: qr.size };
  }, [text]);
  return (
    <svg className="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="QR code for the link" shapeRendering="crispEdges">
      <rect x="-2" y="-2" width={n + 4} height={n + 4} rx="1.5" fill="#fff" />
      <path d={d} fill="#0b1220" />
    </svg>
  );
}
