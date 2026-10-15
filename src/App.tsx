import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElicitRequest, ElicitResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AppFrame, type DisplayMode } from './AppFrame';
import { Elicit } from './Elicit';
import { Assistant, DEFAULT_MODELS, type ModelSettings } from './assistant';
import { type Check, checkResult, checkServer, score } from './checks';
import { runConformance } from './conformance';
import { DEVICES, Device, type DeviceKey, type Light } from './Device';
import { Connection, endpointFor, type ToolResult, type Traffic, taskSupportOf, textOf, uiResourceOf, visibilityOf } from './mcp';
import { type ProbeMetrics, probeChecks, withProbe } from './probe';
import { reportMarkdown } from './report';
import { ReportView } from './ReportView';
import { Sev } from './Sev';
import { argsOf, fieldsOf } from './schema';
import { type Line, TalkPanel } from './TalkPanel';
import { Compare } from './Compare';
import { Icon } from './icons';
import { type Command, Palette } from './Palette';
import { formatMs, type RunRecord, type Segment, Sparkline, serverTimeOf, totalOf, Waterfall } from './Timeline';
import { canListen, listen, speak, stopSpeaking } from './voice';

type Screen =
  | { kind: 'card'; id: number; tool: string; uri: string; args: Record<string, unknown>; result: ToolResult; html: string; mode: DisplayMode }
  | { kind: 'text'; id: number; tool: string; text: string; isError: boolean };

const stored = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // private mode: nothing is remembered
  }
};

const EXAMPLES = [{ name: "While You're Out", what: 'Babysitting add-on · MCP Apps cards, tasks, elicitation', url: 'https://while-youre-out-wpj3.onrender.com/mcp' }];
const LOCALES = ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'es-US', 'de-DE', 'fr-FR', 'ja-JP'];
let nextId = 1;

export function App() {
  // ---------- connection ----------
  const [url, setUrl] = useState(() => new URLSearchParams(location.search).get('url') ?? stored('sim.url', ''));
  const [headersText, setHeadersText] = useState(() => stored('sim.headers', ''));
  const [proxyAvailable, setProxyAvailable] = useState(false);
  const [viaProxy, setViaProxy] = useState(() => stored('sim.proxy', '1') === '1');
  const [conn, setConn] = useState<Connection | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [error, setError] = useState('');
  const connRef = useRef<Connection | null>(null);
  connRef.current = conn;

  // ---------- what was learned ----------
  const [traffic, setTraffic] = useState<Traffic[]>([]);
  const [runChecks, setRunChecks] = useState<Check[]>([]);
  const [probe, setProbe] = useState<Check[]>([]);
  const [conformance, setConformance] = useState<Check[] | null>(null);
  const [testing, setTesting] = useState(false);

  // ---------- the device ----------
  const [device, setDevice] = useState<DeviceKey>(() => (stored('sim.device2', 'show15') as DeviceKey) in DEVICES ? (stored('sim.device2', 'show15') as DeviceKey) : 'show15');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (stored('sim.theme', 'dark') === 'light' ? 'light' : 'dark'));
  const [locale, setLocale] = useState(() => stored('sim.locale', 'en-US'));
  const [far, setFar] = useState(false);
  const [speakOn, setSpeakOn] = useState(() => stored('sim.speak', '1') === '1');
  const [screen, setScreen] = useState<Screen | null>(null);
  const [light, setLight] = useState<Light>('idle');
  const [caption, setCaption] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ params: ElicitRequest['params']; resolve: (r: ElicitResult) => void } | null>(null);
  const waitingMs = useRef(0);

  // ---------- panels ----------
  const [left, setLeft] = useState<'talk' | 'tools' | 'tests'>('talk');
  const [right, setRight] = useState<'report' | 'result' | 'traffic'>('report');
  const [trafficFilter, setTrafficFilter] = useState<'all' | 'server' | 'card'>('all');
  const [toast, setToast] = useState<string | null>(null);
  const [appTheme, setAppTheme] = useState<'light' | 'dark'>(() => (stored('sim.ui', 'light') === 'dark' ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.dataset.theme = appTheme;
    store('sim.ui', appTheme);
  }, [appTheme]);
  const [comparing, setComparing] = useState(false);
  const [palette, setPalette] = useState(false);
  // Every turn and tool run, with its parts in time (the Result tab's waterfall).
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [shownRun, setShownRun] = useState<number | null>(null);
  const current = useRef<RunRecord | null>(null);
  const begin = (kind: RunRecord['kind'], label: string) => {
    current.current = { id: nextId++, kind, label, start: performance.now(), segments: [] };
    setShownRun(null);
  };
  const segment = useCallback((seg: Segment) => {
    const r = current.current;
    if (!r) return;
    r.segments = [...r.segments, seg];
    const copy = { ...r };
    setRuns((all) => [copy, ...all.filter((x) => x.id !== copy.id)].slice(0, 30));
  }, []);

  // ---------- tools ----------
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<{ tool: string; args: Record<string, unknown>; result?: ToolResult; error?: string; ms: number } | null>(null);

  // ---------- talk ----------
  const [settings, setSettings] = useState<ModelSettings>(() => {
    try {
      const s = JSON.parse(stored('sim.model', '{}')) as Partial<ModelSettings>;
      return { provider: s.provider ?? 'gemini', apiKey: s.apiKey ?? '', model: s.model ?? DEFAULT_MODELS[s.provider ?? 'gemini'], baseUrl: s.baseUrl ?? '' };
    } catch {
      return { provider: 'gemini', apiKey: '', model: DEFAULT_MODELS.gemini, baseUrl: '' };
    }
  });
  const [lines, setLines] = useState<Line[]>([]);
  const [talking, setTalking] = useState(false);
  const [interim, setInterim] = useState('');
  const stopListening = useRef<() => void>(() => {});

  useEffect(() => {
    fetch('/proxy')
      .then((r) => r.status === 400 && r.headers.get('content-type')?.includes('json'))
      .then((ok) => setProxyAvailable(Boolean(ok)))
      .catch(() => setProxyAvailable(false));
  }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('url')) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') {
        setPalette(false);
        setComparing(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };
  const log = useCallback((t: Omit<Traffic, 'id'>) => setTraffic((all) => [...all.slice(-799), { ...t, id: nextId++ }]), []);
  const headers = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of headersText.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }, [headersText]);
  const routed = proxyAvailable && viaProxy;

  async function connect(target = url) {
    await connRef.current?.close().catch(() => {});
    setConn(null);
    setScreen(null);
    setRunChecks([]);
    setProbe([]);
    setConformance(null);
    setTraffic([]);
    setLast(null);
    setSelected(null);
    setLines([]);
    setUrl(target);
    setState('connecting');
    setError('');
    store('sim.url', target);
    store('sim.headers', headersText);
    try {
      const c = await Connection.open(target, {
        headers,
        viaProxy: routed,
        onTraffic: log,
        // Time spent waiting for the person to answer is not the server's time.
        elicit: (params) => {
          const started = performance.now();
          setLight('idle');
          return new Promise<ElicitResult>((resolve) =>
            setAsk({
              params,
              resolve: (r) => {
                waitingMs.current += performance.now() - started;
                segment({ kind: 'wait', label: 'answering the form', start: started, end: performance.now() });
                resolve(r);
              },
            }),
          );
        },
        elicitationComplete: () => setCaption('The server says the step on the phone is done.'),
      });
      setConn(c);
      setState('connected');
      setRight('report');
      if (!c.snapshot.tools.some((t) => visibilityOf(t).includes('model'))) setLeft('tools');
    } catch (e) {
      setState('error');
      const message = e instanceof Error ? e.message : String(e);
      setError(/failed to fetch|networkerror|load failed/i.test(message) && !routed ? `${message}. The server may not allow web pages to call it (CORS). Run the simulator with npm start and use the local proxy.` : message);
    }
  }

  // ---------- the report ----------
  const serverChecks = useMemo(() => (conn ? checkServer(conn.snapshot) : []), [conn]);
  const allChecks = useMemo(() => [...serverChecks, ...runChecks, ...probe, ...(conformance ?? [])], [serverChecks, runChecks, probe, conformance]);
  const overall = score(allChecks).overall;
  const exportReport = async () => {
    if (!conn) return;
    const md = reportMarkdown(conn.snapshot, allChecks);
    try {
      await navigator.clipboard.writeText(md);
      flash('Report copied as Markdown');
    } catch {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = 'alexa-readiness.md';
      a.click();
      flash('Report downloaded');
    }
  };

  // ---------- showing results ----------
  const say = useCallback(
    (text: string) => {
      if (!speakOn || !text) return setLight('idle');
      let started = 0;
      speak(
        text,
        locale,
        () => {
          started = performance.now();
          setLight('speaking');
        },
        () => {
          if (started) segment({ kind: 'speech', label: `${text.split(/\s+/).length} words`, start: started, end: performance.now() });
          setLight('idle');
        },
      );
    },
    [speakOn, locale, segment],
  );

  /** A result the way an Echo Show shows it: its card, or its words. Returns whether a card is up. */
  const show = useCallback((t: Tool | undefined, a: Record<string, unknown>, result: ToolResult): boolean => {
    const c = connRef.current;
    const uri = uiResourceOf(t);
    const html = uri ? c?.html(uri) : undefined;
    const wantsFull = (t?._meta as Record<string, any> | undefined)?.ui?.preferredDisplayMode === 'fullscreen';
    if (html && t && uri) {
      setScreen((old) =>
        // The same card again (a refresh): keep the frame, send the new result.
        old && old.kind === 'card' && old.uri === uri && old.tool === t.name ? { ...old, args: a, result } : { kind: 'card', id: nextId++, tool: t.name, uri, args: a, result, html: withProbe(html), mode: wantsFull ? 'fullscreen' : 'inline' },
      );
      return true;
    }
    setScreen({ kind: 'text', id: nextId++, tool: t?.name ?? '', text: textOf(result) || '(no text)', isError: Boolean(result.isError) });
    return false;
  }, []);

  // A tool's latest run replaces what its earlier runs said.
  const record = useCallback(
    (t: Tool | undefined, result: ToolResult, ms: number) => setRunChecks((old) => [...old.filter((c) => !(c.id.startsWith('run-') && c.tools?.[0] === t?.name)), ...checkResult(t, result, ms)]),
    [],
  );

  // ---------- tools tab ----------
  const tools = conn?.snapshot.tools ?? [];
  const shownTools = tools.filter((t) => !filter || `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const tool = selected ? conn?.tool(selected) : undefined;
  const fields = useMemo(() => fieldsOf(tool?.inputSchema), [tool]);
  useEffect(() => {
    setValues(Object.fromEntries(fields.map((f) => [f.key, f.initial])));
  }, [fields]);
  const { args, errors } = argsOf(fields, values);

  const run = async (asTask: boolean) => {
    if (!conn || !tool || Object.keys(errors).length) return;
    setBusy(asTask ? 'Starting the task…' : `Running ${tool.name}…`);
    setLight('thinking');
    setRight('result');
    waitingMs.current = 0;
    begin('tool', tool.name);
    const t0 = performance.now();
    try {
      let result: ToolResult | undefined;
      if (asTask) {
        for await (const u of conn.callAsTask(tool.name, args)) {
          if (u.status) setBusy(`Task: ${u.status}`);
          if (u.result) result = u.result;
        }
      } else result = await conn.call(tool.name, args);
      const ms = performance.now() - t0 - waitingMs.current;
      segment({ kind: 'tool', label: asTask ? `${tool.name} (task)` : tool.name, start: t0, end: performance.now() });
      if (!result) throw new Error('The task ended without a result.');
      setLast({ tool: tool.name, args, result, ms });
      record(tool, result, ms);
      show(tool, args, result);
      say(textOf(result));
    } catch (e) {
      setLast({ tool: tool.name, args, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 - waitingMs.current });
      setLight('idle');
    } finally {
      setBusy(null);
    }
  };

  // ---------- talk tab ----------
  useEffect(() => {
    store('sim.model', JSON.stringify(settings));
  }, [settings]);
  const assistant = useMemo(() => {
    if (!conn) return null;
    return new Assistant({
      settings,
      tools: conn.snapshot.tools,
      instructions: conn.snapshot.instructions,
      route: routed ? (u) => endpointFor(u, true) : undefined,
      onTiming: (t) => segment(t),
      callTool: async (name, a) => {
        waitingMs.current = 0;
        return conn.call(name, a);
      },
      onStep: (s) => {
        const t = conn.tool(s.name);
        const ms = s.ms - waitingMs.current;
        setLines((l) => [...l, { id: nextId++, who: 'step', name: s.name, ms, ok: !s.error && !s.result?.isError, note: s.error ?? (s.result?.isError ? textOf(s.result) : undefined) }]);
        if (s.result) {
          setLast({ tool: s.name, args: s.args, result: s.result, ms });
          record(t, s.result, ms);
          show(t, s.args, s.result);
        }
      },
    });
  }, [conn, settings, routed, record, show, segment]);

  const hear = useCallback(
    async (text: string) => {
      if (!assistant) return;
      stopSpeaking();
      setLines((l) => [...l, { id: nextId++, who: 'you', text }]);
      begin('talk', text);
      setCaption(null);
      setTalking(true);
      setLight('thinking');
      try {
        const turn = await assistant.hear(text);
        const reply = turn.reply || (turn.steps.length ? '' : "I'm not sure how to help with that.");
        if (reply) setLines((l) => [...l, { id: nextId++, who: 'alexa', text: reply }]);
        // With a card up, Alexa speaks over it; without one, her words are the screen.
        const lastStep = turn.steps.at(-1);
        const cardUp = Boolean(lastStep && uiResourceOf(connRef.current?.tool(lastStep.name)) && lastStep.result);
        if (reply && cardUp) setCaption(reply);
        else if (reply && !lastStep?.result) setScreen({ kind: 'text', id: nextId++, tool: 'Alexa', text: reply, isError: false });
        say(reply || (lastStep?.result ? textOf(lastStep.result) : ''));
      } catch (e) {
        setLines((l) => [...l, { id: nextId++, who: 'error', text: e instanceof Error ? e.message : String(e) }]);
        setLight('idle');
      } finally {
        setTalking(false);
      }
    },
    [assistant, say],
  );

  const onMic = async () => {
    if (light === 'listening') return stopListening.current();
    stopSpeaking();
    setLight('listening');
    const session = listen(locale, setInterim);
    stopListening.current = session.stop;
    const heard = await session.done;
    setInterim('');
    setLight('idle');
    if (heard) void hear(heard);
  };

  // A card calling a tool: only tools whose MCP Apps visibility includes "app".
  const cardToolCall = useCallback(async (name: string, a: Record<string, unknown>) => {
    const c = connRef.current;
    if (!c) throw new Error('Not connected');
    const t = c.tool(name);
    if (!t) throw new Error(`No tool named ${name}`);
    if (!visibilityOf(t).includes('app')) {
      setRunChecks((old) => [...old.filter((x) => x.id !== `card-visibility:${name}`), { id: `card-visibility:${name}`, level: 'fail', title: `A card called ${name}, which is not visible to apps`, detail: 'Add "app" to its _meta.ui.visibility, or hosts refuse the call.', tools: [name] }]);
      throw new Error(`${name} is not visible to apps (_meta.ui.visibility)`);
    }
    return c.call(name, a);
  }, []);

  // A card speaking for the person ("Emergency" button): the assistant hears it, as Alexa+ would.
  const cardMessage = useCallback(
    (text: string) => {
      if (assistant && (settings.apiKey || settings.provider === 'openai')) void hear(text);
      else setCaption(`The card said, for the person: “${text}” (add a model key to have the assistant answer it)`);
    },
    [assistant, hear, settings],
  );

  const onProbe = useCallback(
    (uri: string, mode: DisplayMode) => (m: ProbeMetrics) => setProbe((old) => [...old.filter((c) => !c.id.endsWith(`:${uri}`)), ...probeChecks(uri, m, mode === 'fullscreen')]),
    [],
  );

  const runTests = async () => {
    if (!conn) return;
    setTesting(true);
    try {
      setConformance(
        await runConformance({
          request: (m, p) => conn.request(m, p),
          call: (n, a) => conn.call(n, a),
          tools: conn.snapshot.tools,
          capabilities: conn.snapshot.capabilities,
          endpoint: conn.endpoint,
          headers: conn.headers,
          sessionId: conn.sessionId,
          protocolVersion: conn.snapshot.protocolVersion,
        }),
      );
      setRight('report');
    } finally {
      setTesting(false);
    }
  };

  const shareLink = async () => {
    if (!conn) return;
    const link = `${location.origin}${location.pathname}?url=${encodeURIComponent(conn.snapshot.url)}`;
    try {
      await navigator.clipboard.writeText(link);
      flash('Link copied: it opens this server here');
    } catch {
      flash(link);
    }
  };

  const commands: Command[] = [
    ...tools.map((t) => ({
      id: `tool:${t.name}`,
      label: `Run ${t.title ?? t.name}`,
      hint: t.name,
      icon: 'play',
      run: () => {
        setLeft('tools');
        setSelected(t.name);
      },
    })),
    ...(Object.keys(DEVICES) as DeviceKey[]).map((k) => ({
      id: `device:${k}`,
      label: `Show on ${DEVICES[k].label}`,
      hint: `${DEVICES[k].width} × ${DEVICES[k].height}`,
      icon: 'compare',
      run: () => {
        setDevice(k);
        store('sim.device2', k);
      },
    })),
    { id: 'tests', label: 'Run robustness tests', icon: 'tests', run: () => (setLeft('tests'), void runTests()) },
    { id: 'compare', label: 'Compare screens', hint: 'the card on every Echo screen', icon: 'compare', run: () => screen?.kind === 'card' && setComparing(true) },
    { id: 'theme', label: theme === 'dark' ? 'Light theme' : 'Dark theme', icon: theme === 'dark' ? 'sun' : 'moon', run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) },
    { id: 'far', label: far ? 'Back to arm’s length' : 'From across the room', icon: 'eye', run: () => setFar((f) => !f) },
    { id: 'report', label: 'Copy the readiness report', hint: 'Markdown', icon: 'copy', run: () => void exportReport() },
    { id: 'share', label: 'Copy a link to this server', icon: 'share', run: () => void shareLink() },
    { id: 'talk', label: 'Talk to your add-on', icon: 'talk', run: () => setLeft('talk') },
    { id: 'reconnect', label: 'Reconnect', icon: 'refresh', run: () => void connect(conn?.snapshot.url) },
  ];

  const dev = DEVICES[device];
  const shownTraffic = traffic.filter((t) => trafficFilter === 'all' || (trafficFilter === 'server' ? t.dir === 'in' || t.dir === 'out' : t.dir.startsWith('card')));

  // ---------- not connected yet: the welcome ----------
  if (!conn)
    return (
      <div className="welcome">
        <header className="top">
          <Brand />
          <nav className="top-links">
            <ThemeToggle theme={appTheme} onChange={setAppTheme} />
            <a href="https://github.com/murthyroshan/alexa-addon-simulator" target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>
        </header>
        <main className="hero">
          <div className="hero-text">
            <p className="kicker">Open source · MIT · runs on your computer</p>
            <h1>Test your Alexa+ add-on on an Echo Show.</h1>
            <p className="lede">Point it at your MCP server. Talk to it the way Alexa+ would, see its cards on seven Echo screens, and get a list of exactly what to fix before you ship.</p>
            <form
              className="connect"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) void connect(url.trim());
              }}
            >
              <label className="sr" htmlFor="server-url">
                Your MCP server's URL
              </label>
              <input id="server-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000/mcp" spellCheck={false} autoFocus />
              <button className="primary" disabled={state === 'connecting' || !url.trim()}>
                {state === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            </form>
            <div className="connect-extra">
              <details>
                <summary>Add a header</summary>
                <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder="Authorization: Bearer …" rows={2} spellCheck={false} />
              </details>
              {proxyAvailable ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={viaProxy}
                    onChange={(e) => {
                      setViaProxy(e.target.checked);
                      store('sim.proxy', e.target.checked ? '1' : '0');
                    }}
                  />
                  Use the local proxy (no CORS setup needed)
                </label>
              ) : (
                <span className="muted">Without the local proxy your server must allow this page (CORS). Run it with npm start to skip that.</span>
              )}
            </div>
            {error && <p className="error">{error}</p>}
            <p className="example-line">
              No server at hand?{' '}
              {EXAMPLES.map((ex) => (
                <button key={ex.url} className="link" onClick={() => void connect(ex.url)} disabled={state === 'connecting'}>
                  Open {ex.name}
                </button>
              ))}
              , a babysitting add-on with cards, tasks and on-screen forms.
            </p>
          </div>

          <figure className="specimen" aria-label="What the simulator marks on a card">
            <div className="specimen-device">
              <div className="specimen-screen">
                <div className="sp-top">
                  <span>6:12</span>
                  <span className="sp-chip">Sitter mode</span>
                </div>
                <div className="sp-card">
                  <span className="sp-label">Up next</span>
                  <b>Dinner</b>
                  <span className="sp-sub">6:30 pm · in 18 min</span>
                  <span className="sp-fine">
                    Dal and rice in the fridge, 2 minutes.
                    <i className="mark m1">1</i>
                  </span>
                </div>
                <div className="sp-side">
                  <span>Maya · peanut allergy</span>
                  <span>Bruno · fed at 7</span>
                </div>
                <span className="sp-x">
                  ×<i className="mark m2">2</i>
                </span>
                <i className="sp-light" />
              </div>
            </div>
            <ol className="notes">
              <li>
                <i className="mark">1</i>
                <div>
                  <b>13 px text</b>
                  <span>Too small to read from the stove. Body text needs 18 px or more.</span>
                </div>
              </li>
              <li>
                <i className="mark">2</i>
                <div>
                  <b>32 × 32 touch target</b>
                  <span>Wet fingers need 48 × 48.</span>
                </div>
              </li>
              <li>
                <i className="mark score">87</i>
                <div>
                  <b>Readiness, out of 100</b>
                  <span>Protocol, tools, cards, voice, speed, robustness.</span>
                </div>
              </li>
            </ol>
          </figure>
        </main>

        <section className="spec-sheet" aria-label="What it does">
          <dl>
            <div>
              <dt>Talk</dt>
              <dd>An assistant picks your tools from their descriptions, as Alexa+ has to. Voice in and out. Your own Gemini or OpenAI-compatible key, kept in your browser.</dd>
            </div>
            <div>
              <dt>Screens</dt>
              <dd>MCP Apps on Echo Show 5, 8, 10, 15 (and portrait), 21 and Hub. Dark or light, any language, inline or full screen, or all seven at once.</dd>
            </div>
            <div>
              <dt>Card audit</dt>
              <dd>Measured inside your card while it runs: text size, contrast (WCAG), touch targets, and whether it fits the screen.</dd>
            </div>
            <div>
              <dt>Robustness</dt>
              <dd>Unknown methods and tools, missing arguments, lost sessions, the event stream: what MCP 2025-11-25 expects, checked in one go.</dd>
            </div>
            <div>
              <dt>Timeline</dt>
              <dd>Every turn split into model, your server, the person and speech, so you see where the seconds go.</dd>
            </div>
            <div>
              <dt>Traffic</dt>
              <dd>Every JSON-RPC message with your server and with your card, forms and links (elicitation), tasks, and a Markdown report for your pull request.</dd>
            </div>
          </dl>
        </section>
      </div>
    );

  // ---------- the workspace ----------
  return (
    <div className="page">
      <header className="top">
        <Brand />
        <div className="server">
          <span className={`pill ${state}`}>
            <i />
            {conn.snapshot.serverInfo?.title ?? conn.snapshot.serverInfo?.name} · MCP {conn.snapshot.protocolVersion}
          </span>
          <button className="score-pill" onClick={() => setRight('report')} title="Readiness score">
            <span>Readiness</span>
            <b className={overall === null ? '' : overall >= 85 ? 'good' : overall >= 60 ? 'ok' : 'bad'}>{overall ?? '–'}</b>
          </button>
          <button className="small-btn icon-btn" onClick={() => setComparing(true)} disabled={screen?.kind !== 'card'} title={screen?.kind === 'card' ? 'Your card on every Echo screen' : 'Show a card first'}>
            <Icon name="compare" /> Compare screens
          </button>
          <button className="small-btn icon-btn" onClick={() => void exportReport()}>
            <Icon name="copy" /> Report
          </button>
          <button className="small-btn icon-btn" onClick={() => void shareLink()} title="Copy a link that opens this server here">
            <Icon name="share" /> Share
          </button>
          <button className="small-btn icon-btn ghost kbd" onClick={() => setPalette(true)} title="Command palette">
            <Icon name="command" /> <kbd>Ctrl K</kbd>
          </button>
          <button className="small-btn ghost" onClick={() => void connect(conn.snapshot.url)} title="Reconnect">
            <Icon name="refresh" />
          </button>
          <button
            className="small-btn ghost"
            onClick={() => {
              void conn.close();
              setConn(null);
              setState('idle');
            }}
          >
            Disconnect
          </button>
          <ThemeToggle theme={appTheme} onChange={setAppTheme} />
        </div>
      </header>

      <aside className="side">
        <div className="tabs" role="tablist">
          {(['talk', 'tools', 'tests'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={left === t} className={left === t ? 'on' : ''} onClick={() => setLeft(t)}>
              <Icon name={t} /> {t === 'talk' ? 'Talk' : t === 'tools' ? `Tools · ${tools.length}` : 'Tests'}
            </button>
          ))}
        </div>

        {left === 'talk' && (
          <TalkPanel lines={lines} settings={settings} onSettings={setSettings} onSend={(t) => void hear(t)} busy={talking} canListen={canListen()} listening={light === 'listening'} interim={interim} onMic={() => void onMic()} />
        )}

        {left === 'tools' && (
          <div className="tools-tab">
            {tools.length > 6 && <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tool" />}
            <ul className="tool-list">
              {shownTools.map((t) => (
                <li key={t.name}>
                  <button className={t.name === selected ? 'on' : ''} onClick={() => setSelected(t.name === selected ? null : t.name)}>
                    <b>{t.title ?? t.name}</b>
                    <code>{t.name}</code>
                    <span className="tags">
                      {uiResourceOf(t) && <em className="card">card</em>}
                      {taskSupportOf(t) !== 'forbidden' && <em className="task">task</em>}
                      {!visibilityOf(t).includes('model') && <em>app only</em>}
                      {t.annotations?.readOnlyHint && <em>read-only</em>}
                      {t.annotations?.destructiveHint && <em className="warn">changes data</em>}
                    </span>
                  </button>
                  {tool && t.name === selected && (
                    <form
                      className="runner"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(taskSupportOf(tool) === 'required');
                      }}
                    >
                      {tool.description && <p className="muted">{tool.description}</p>}
                      {fields.length === 0 && <p className="muted small">No arguments.</p>}
                      {fields.map((f) => (
                        <label key={f.key} className="field">
                          <span>
                            {f.label}
                            {f.required ? '' : ' (optional)'}
                            {errors[f.key] && values[f.key] !== '' && <b className="bad"> · {errors[f.key]}</b>}
                          </span>
                          {f.kind === 'choice' || f.kind === 'boolean' ? (
                            <select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                              {!f.required && <option value="">—</option>}
                              {(f.kind === 'boolean' ? [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }] : f.options ?? []).map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : f.kind === 'longtext' || f.kind === 'json' || f.kind === 'list' ? (
                            <textarea rows={3} value={values[f.key] ?? ''} placeholder={f.kind === 'list' ? 'One per line' : f.kind === 'json' ? 'JSON' : f.description} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} spellCheck={false} />
                          ) : (
                            <input type={f.kind === 'number' || f.kind === 'integer' ? 'number' : 'text'} value={values[f.key] ?? ''} placeholder={f.description} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                          )}
                        </label>
                      ))}
                      <div className="row">
                        {taskSupportOf(tool) !== 'required' && (
                          <button className="primary" disabled={Boolean(busy) || Object.keys(errors).length > 0}>
                            Run
                          </button>
                        )}
                        {taskSupportOf(tool) !== 'forbidden' && (
                          <button type="button" className={taskSupportOf(tool) === 'required' ? 'primary' : ''} disabled={Boolean(busy) || Object.keys(errors).length > 0} onClick={() => void run(true)}>
                            Run as a task
                          </button>
                        )}
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {left === 'tests' && (
          <div className="tests-tab">
            <p className="muted">What your server does when things go a little wrong, the way a real assistant makes them go wrong. Only read-only tools are called with bad arguments, so nothing in your service changes.</p>
            <button className="primary" onClick={() => void runTests()} disabled={testing}>
              {testing ? 'Testing…' : conformance ? 'Run again' : 'Run robustness tests'}
            </button>
            {conformance && (
              <ul className="test-list">
                {conformance.map((c) => (
                  <li key={c.id} className={c.level}>
                    <Sev level={c.level} />
                    <div>
                      <b>{c.title}</b>
                      {c.detail && <p>{c.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      <main className={`stage room theme-${theme} light-${light}`}>
        <div className="stage-bar">
          <label className="select">
            <span>Device</span>
            <select
              value={device}
              onChange={(e) => {
                setDevice(e.target.value as DeviceKey);
                store('sim.device2', e.target.value);
              }}
            >
              {(Object.keys(DEVICES) as DeviceKey[]).map((k) => (
                <option key={k} value={k}>
                  {DEVICES[k].label}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                className={theme === t ? 'on' : ''}
                onClick={() => {
                  setTheme(t);
                  store('sim.theme', t);
                }}
              >
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
          <label className="select">
            <span>Language</span>
            <select
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value);
                store('sim.locale', e.target.value);
              }}
            >
              {LOCALES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          {screen?.kind === 'card' && (
            <div className="seg" role="radiogroup" aria-label="Display mode">
              {(['inline', 'fullscreen'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={screen.mode === m} className={screen.mode === m ? 'on' : ''} onClick={() => setScreen((s) => (s && s.kind === 'card' ? { ...s, mode: m } : s))}>
                  {m === 'inline' ? 'Inline' : 'Full screen'}
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={far} onChange={(e) => setFar(e.target.checked)} />
            From across the room
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={speakOn}
              onChange={(e) => {
                setSpeakOn(e.target.checked);
                store('sim.speak', e.target.checked ? '1' : '0');
                if (!e.target.checked) stopSpeaking();
              }}
            />
            Voice
          </label>
        </div>

        <Device width={dev.width} height={dev.height} light={light} far={far}>
          <div className={`os ${theme}`}>
            {!screen && (
              <div className="home-screen">
                <div className="clock">{new Date().toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</div>
                <p>{new Date().toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                <p className="hint-line">{left === 'talk' ? 'Say something on the left: “Alexa, …”' : 'Run a tool: its card or its words appear here.'}</p>
              </div>
            )}
            {screen?.kind === 'text' && (
              <div className={`spoken ${screen.isError ? 'err' : ''}`} key={screen.id}>
                <p className="who">{screen.tool === 'Alexa' ? 'Alexa' : `Alexa · ${screen.tool}`}</p>
                <p>{screen.text}</p>
              </div>
            )}
            {screen?.kind === 'card' && (
              <div className={`card-slot ${screen.mode}`} key={screen.id}>
                <AppFrame
                  html={screen.html}
                  toolName={screen.tool}
                  toolInput={screen.args}
                  toolResult={screen.result}
                  displayMode={screen.mode}
                  device={dev}
                  theme={theme}
                  locale={locale}
                  onProbe={onProbe(screen.uri, screen.mode)}
                  onDisplayMode={(mode) => setScreen((s) => (s && s.kind === 'card' && s.id === screen.id ? { ...s, mode } : s))}
                  onToolCall={cardToolCall}
                  onUserMessage={cardMessage}
                  onOpenLink={(u) => window.open(u, '_blank', 'noopener')}
                  onTraffic={log}
                />
              </div>
            )}
            {screen && (
              <button className="close" onClick={() => setScreen(null)} aria-label="Back to the home screen">
                ✕
              </button>
            )}
            {busy && <div className="busy">{busy}</div>}
            {caption && (
              <div className="caption" role="status" onClick={() => setCaption(null)}>
                {caption}
              </div>
            )}
            {ask && (
              <Elicit
                params={ask.params}
                onDone={(r) => {
                  ask.resolve(r);
                  setAsk(null);
                  setLight('thinking');
                }}
              />
            )}
          </div>
        </Device>
        <p className="device-label">
          {dev.label} · {dev.width} × {dev.height}
          {screen?.kind === 'card' ? ` · ${screen.uri}` : ''}
        </p>
      </main>

      <section className="panel">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={right === 'report'} className={right === 'report' ? 'on' : ''} onClick={() => setRight('report')}>
            <Icon name="report" /> Readiness
          </button>
          <button role="tab" aria-selected={right === 'result'} className={right === 'result' ? 'on' : ''} onClick={() => setRight('result')}>
            <Icon name="result" /> Timeline
          </button>
          <button role="tab" aria-selected={right === 'traffic'} className={right === 'traffic' ? 'on' : ''} onClick={() => setRight('traffic')}>
            <Icon name="traffic" /> Traffic · {traffic.length}
          </button>
        </div>

        {right === 'report' && <ReportView checks={allChecks} connected onExport={() => void exportReport()} />}

        {right === 'result' && (
          <div className="result pad">
            {!last && !runs.length && <p className="muted">Run a tool, or talk to your add-on: each turn shows here as a timeline (model, your server, the person, speech), with the raw result below.</p>}
            {runs.length > 0 && (
              <>
                <div className="speed">
                  <div>
                    <h3>Your server, call by call</h3>
                    <p className="muted small">
                      {runs.length} turn{runs.length === 1 ? '' : 's'} · median {formatMs(median(runs.map(serverTimeOf).filter((v) => v > 0)))}
                    </p>
                  </div>
                  <Sparkline values={[...runs].reverse().map(serverTimeOf).filter((v) => v > 0)} />
                </div>
                <Waterfall run={runs.find((r) => r.id === shownRun) ?? runs[0]} />
                {runs.length > 1 && (
                  <ul className="run-list">
                    {runs.slice(0, 10).map((r) => (
                      <li key={r.id}>
                        <button className={(shownRun ?? runs[0].id) === r.id ? 'on' : ''} onClick={() => setShownRun(r.id)}>
                          <Icon name={r.kind === 'talk' ? 'talk' : 'tools'} />
                          <span>{r.kind === 'talk' ? `“${r.label}”` : r.label}</span>
                          <em>{formatMs(totalOf(r))}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {last && (
              <>
                <p className="summary">
                  <code>{last.tool}</code> · {Math.round(last.ms)} ms {last.result?.isError ? '· isError' : ''}
                </p>
                <h3>Arguments</h3>
                <pre>{JSON.stringify(last.args, null, 2)}</pre>
                <h3>{last.error ? 'Error' : 'Result'}</h3>
                <pre>{last.error ?? JSON.stringify(last.result, null, 2)}</pre>
              </>
            )}
          </div>
        )}

        {right === 'traffic' && (
          <div className="traffic pad">
            <div className="seg small">
              {(['all', 'server', 'card'] as const).map((f) => (
                <button key={f} className={trafficFilter === f ? 'on' : ''} onClick={() => setTrafficFilter(f)}>
                  {f === 'all' ? 'All' : f === 'server' ? 'Server' : 'Card'}
                </button>
              ))}
            </div>
            {shownTraffic.length === 0 && <p className="muted">Every MCP message, between the simulator and your server and between your card and the simulator.</p>}
            {[...shownTraffic].reverse().map((t) => (
              <details key={t.id} className={`msg ${t.dir}`}>
                <summary>
                  <span className="dir">{t.dir === 'out' ? '→ server' : t.dir === 'in' ? '← server' : t.dir === 'card-out' ? '← card' : '→ card'}</span>
                  <span className="method">{summaryOf(t.message)}</span>
                  <time>{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                </summary>
                <pre>{JSON.stringify(t.message, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
      </section>
      {toast && <div className="toast">{toast}</div>}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {comparing && screen?.kind === 'card' && (
        <Compare html={screen.html} tool={screen.tool} args={screen.args} result={screen.result} mode={screen.mode} theme={theme} locale={locale} onToolCall={cardToolCall} onTraffic={log} onClose={() => setComparing(false)} />
      )}
    </div>
  );
}

function median(values: number[]) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function ThemeToggle({ theme, onChange }: { theme: 'light' | 'dark'; onChange: (t: 'light' | 'dark') => void }) {
  return (
    <button className="small-btn ghost theme-toggle" onClick={() => onChange(theme === 'light' ? 'dark' : 'light')} title={theme === 'light' ? 'Dark interface' : 'Light interface'} aria-label={theme === 'light' ? 'Switch to the dark interface' : 'Switch to the light interface'}>
      <Icon name={theme === 'light' ? 'moon' : 'sun'} />
    </button>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <i />
      </span>
      <div>
        <b>Alexa+ add-on simulator</b>
        <small>Your MCP server on an Echo Show</small>
      </div>
    </div>
  );
}

function summaryOf(m: unknown): string {
  const msg = m as { method?: string; id?: unknown; result?: unknown; error?: { message?: string } };
  if (msg.method) return `${msg.method}${msg.id != null ? ` #${msg.id}` : ''}`;
  if (msg.error) return `error #${String(msg.id)}: ${msg.error.message ?? ''}`;
  return `result #${String(msg.id)}`;
}
