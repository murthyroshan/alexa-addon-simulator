import { useEffect, useRef, useState } from 'react';
import type { ToolResult, Traffic } from './mcp';
import type { ProbeMetrics } from './probe';

export type DisplayMode = 'inline' | 'fullscreen';

/**
 * An MCP Apps host for one card: the ui:// resource runs in a sandboxed iframe and talks to the
 * host over postMessage (JSON-RPC). It answers ui/initialize with the device's context, sends the
 * tool's input and result, lets the card call the server's tools and speak for the user, and
 * switches display modes. Every message is shown in the traffic view.
 */
export function AppFrame(props: {
  html: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: ToolResult;
  displayMode: DisplayMode;
  device: { width: number; height: number };
  theme: 'dark' | 'light';
  locale: string;
  /** What the card audit measured inside the card. */
  onProbe?: (m: ProbeMetrics) => void;
  onDisplayMode: (mode: DisplayMode) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onUserMessage: (text: string) => void;
  onOpenLink: (url: string) => void;
  onTraffic: (t: Omit<Traffic, 'id'>) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const ready = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const post = (msg: unknown) => {
      latest.current.onTraffic({ at: Date.now(), dir: 'card-in', message: msg });
      frame.contentWindow?.postMessage(msg, '*');
    };
    const reply = (id: unknown, result: unknown) => post({ jsonrpc: '2.0', id, result });
    const fail = (id: unknown, message: string, code = -32601) => post({ jsonrpc: '2.0', id, error: { code, message } });
    const sendToolData = () => {
      const p = latest.current;
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: p.toolInput } });
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: p.toolResult });
    };

    const onMessage = async (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (m?.type === 'sim-probe') return void latest.current.onProbe?.(m.metrics as ProbeMetrics);
      if (!m || m.jsonrpc !== '2.0') return;
      const p = latest.current;
      p.onTraffic({ at: Date.now(), dir: 'card-out', message: m });
      if (m.method === 'ui/initialize' && m.id != null) {
        reply(m.id, {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'alexa-addon-simulator', version: '0.1.0' },
          hostCapabilities: { serverTools: {}, message: {}, openLinks: {}, displayModes: ['inline', 'fullscreen'] },
          hostContext: {
            theme: p.theme,
            locale: p.locale,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            displayMode: p.displayMode,
            availableDisplayModes: ['inline', 'fullscreen'],
            platform: 'web',
            deviceCapabilities: { touch: true, hover: false },
            containerDimensions: p.displayMode === 'fullscreen' ? { width: p.device.width, height: p.device.height } : { width: p.device.width, maxHeight: p.device.height },
            toolInfo: { tool: { name: p.toolName } },
          },
        });
      } else if (m.method === 'ui/notifications/initialized') {
        ready.current = true;
        sendToolData();
      } else if (m.method === 'ui/notifications/size-changed') {
        const h = m.params?.height;
        // Ignore zero (hidden) and tiny changes, which could otherwise loop.
        if (typeof h === 'number' && h > 0) setHeight((old) => (Math.abs(old - h) > 2 ? Math.min(Math.max(h, 80), 4000) : old));
      } else if (m.method === 'ui/request-display-mode' && m.id != null) {
        const mode: DisplayMode = m.params?.mode === 'fullscreen' ? 'fullscreen' : 'inline';
        p.onDisplayMode(mode);
        reply(m.id, { mode });
      } else if (m.method === 'tools/call' && m.id != null) {
        const name = m.params?.name;
        if (typeof name !== 'string') return fail(m.id, 'tools/call needs a tool name', -32602);
        try {
          reply(m.id, await p.onToolCall(name, (m.params?.arguments as Record<string, unknown>) ?? {}));
        } catch (err) {
          fail(m.id, err instanceof Error ? err.message : String(err), -32603);
        }
      } else if (m.method === 'ui/message' && m.id != null) {
        const content = m.params?.content;
        const blocks = Array.isArray(content) ? content : content ? [content] : [];
        const text = blocks.map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text ?? '' : '')).join(' ').trim();
        if (!text) return fail(m.id, 'ui/message needs text content', -32602);
        p.onUserMessage(text);
        reply(m.id, {});
      } else if (m.method === 'ui/open-link' && m.id != null) {
        const url = String(m.params?.url ?? '');
        if (!/^https?:\/\//.test(url)) return fail(m.id, 'Only http(s) links', -32602);
        p.onOpenLink(url);
        reply(m.id, {});
      } else if (m.id != null) {
        fail(m.id, `Not supported by the simulator: ${m.method}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A new result for the same card: send it once the card is ready.
  useEffect(() => {
    if (!ready.current) return;
    const msg = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: props.toolResult };
    props.onTraffic({ at: Date.now(), dir: 'card-in', message: msg });
    ref.current?.contentWindow?.postMessage(msg, '*');
  }, [props.toolResult]);

  useEffect(() => {
    if (!ready.current) return;
    const msg = { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: props.displayMode, theme: props.theme, locale: props.locale, containerDimensions: { width: props.device.width, height: props.device.height } } };
    props.onTraffic({ at: Date.now(), dir: 'card-in', message: msg });
    ref.current?.contentWindow?.postMessage(msg, '*');
  }, [props.displayMode, props.theme, props.locale, props.device.width, props.device.height]);

  return (
    <iframe
      ref={ref}
      title={`${props.toolName} card`}
      className={`app-frame ${props.displayMode}`}
      sandbox="allow-scripts"
      allow="autoplay"
      srcDoc={props.html}
      style={props.displayMode === 'fullscreen' ? undefined : { height: Math.min(height, props.device.height - 40) }}
    />
  );
}
