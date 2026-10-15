// The simulator's MCP client: it plays the part Alexa+ plays in production. It connects over
// Streamable HTTP, declares elicitation (forms and links) like Alexa+, renders MCP Apps, runs tools
// as tasks, and records every message so you can see exactly what your server said.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema, type ElicitRequest, type ElicitResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface Traffic {
  id: number;
  at: number;
  dir: 'out' | 'in' | 'card-out' | 'card-in';
  message: unknown;
}

export interface ConnectOptions {
  /** Extra request headers, e.g. Authorization for a server that needs a token. */
  headers?: Record<string, string>;
  /** Go through this page's own /proxy (for servers that don't allow browser pages). */
  viaProxy?: boolean;
  elicit?: (params: ElicitRequest['params']) => Promise<ElicitResult>;
  elicitationComplete?: (id: string) => void;
  onTraffic?: (t: Omit<Traffic, 'id'>) => void;
}

export interface ServerSnapshot {
  url: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; title?: string; version?: string; description?: string; websiteUrl?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
  sessionId?: string;
  tools: Tool[];
  resources: UiResource[];
  timings: { initializeMs: number; listToolsMs: number };
}

export interface UiResource {
  uri: string;
  tools: string[];
  mimeType?: string;
  size?: number;
  html?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export const endpointFor = (url: string, viaProxy: boolean) => (viaProxy ? `${location.origin}/proxy?target=${encodeURIComponent(url)}` : url);

/** The MCP App (ui:// resource) a tool shows its result in, if any. */
export function uiResourceOf(tool: Tool | undefined): string | undefined {
  const meta = tool?._meta as Record<string, any> | undefined;
  return meta?.ui?.resourceUri ?? meta?.['ui/resourceUri'];
}

/** MCP Apps visibility: who may call the tool ("model", "app"). Default: both. */
export function visibilityOf(tool: Tool | undefined): string[] {
  const v = (tool?._meta as Record<string, any> | undefined)?.ui?.visibility;
  return Array.isArray(v) ? v : ['model', 'app'];
}

/** Whether the tool can run as an MCP task (long work that reports progress). */
export function taskSupportOf(tool: Tool | undefined): 'forbidden' | 'optional' | 'required' {
  const s = (tool as { execution?: { taskSupport?: string } } | undefined)?.execution?.taskSupport;
  return s === 'optional' || s === 'required' ? s : 'forbidden';
}

export class Connection {
  /** Where requests actually go (the proxy, or the server), and the headers they carry. */
  public endpoint = '';
  public headers: Record<string, string> = {};

  private constructor(
    private client: Client,
    private transport: StreamableHTTPClientTransport,
    public snapshot: ServerSnapshot,
  ) {}

  /** Any JSON-RPC request, answered as it comes (for the robustness tests). */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.client.request({ method, params } as never, z.any() as never);
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  static async open(url: string, opts: ConnectOptions = {}): Promise<Connection> {
    const client = new Client({ name: 'alexa-addon-simulator', version: '0.1.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => (opts.elicit ? opts.elicit(req.params) : { action: 'decline' }));
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => opts.elicitationComplete?.(n.params.elicitationId));
    const transport = new StreamableHTTPClientTransport(new URL(endpointFor(url, Boolean(opts.viaProxy))), {
      requestInit: opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : undefined,
    });
    record(transport, opts.onTraffic);

    let t = performance.now();
    await client.connect(transport);
    const initializeMs = performance.now() - t;
    t = performance.now();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    const listToolsMs = performance.now() - t;

    const conn = new Connection(client, transport, {
      url,
      protocolVersion: transport.protocolVersion,
      serverInfo: client.getServerVersion() as ServerSnapshot['serverInfo'],
      capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
      instructions: client.getInstructions(),
      sessionId: transport.sessionId,
      tools,
      resources: [],
      timings: { initializeMs, listToolsMs },
    });
    conn.snapshot.resources = await conn.readUiResources();
    conn.endpoint = endpointFor(url, Boolean(opts.viaProxy));
    conn.headers = opts.headers ?? {};
    return conn;
  }

  /** Every MCP App the tools point to, read once (for the readiness report and for showing cards). */
  private async readUiResources(): Promise<UiResource[]> {
    const byUri = new Map<string, string[]>();
    for (const tool of this.snapshot.tools) {
      const uri = uiResourceOf(tool);
      if (uri) byUri.set(uri, [...(byUri.get(uri) ?? []), tool.name]);
    }
    const out: UiResource[] = [];
    for (const [uri, tools] of byUri) {
      try {
        const res = await this.client.readResource({ uri });
        const first = res.contents[0] as { text?: string; blob?: string; mimeType?: string; _meta?: Record<string, unknown> } | undefined;
        const html = first?.text ?? (first?.blob ? atob(first.blob) : undefined);
        out.push({ uri, tools, mimeType: first?.mimeType, size: html ? new Blob([html]).size : 0, html, meta: first?._meta });
      } catch (e) {
        out.push({ uri, tools, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  tool(name: string): Tool | undefined {
    return this.snapshot.tools.find((t) => t.name === name);
  }

  html(uri: string): string | undefined {
    return this.snapshot.resources.find((r) => r.uri === uri)?.html;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as ToolResult;
  }

  /** Runs a tool as an MCP task, reporting its status until the result arrives. */
  async *callAsTask(name: string, args: Record<string, unknown>): AsyncGenerator<{ status?: string; result?: ToolResult }> {
    for await (const msg of this.client.experimental.tasks.callToolStream({ name, arguments: args })) {
      if (msg.type === 'taskCreated' || msg.type === 'taskStatus') yield { status: msg.task.statusMessage ?? msg.task.status };
      else if (msg.type === 'result') yield { result: msg.result as ToolResult };
      else if (msg.type === 'error') throw msg.error;
    }
  }

  async close() {
    await this.transport.terminateSession().catch(() => {});
    await this.client.close();
  }
}

/** Records what goes out and what comes in, without changing either. */
function record(transport: StreamableHTTPClientTransport, onTraffic?: ConnectOptions['onTraffic']) {
  if (!onTraffic) return;
  const send = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, options?: Parameters<StreamableHTTPClientTransport['send']>[1]) => {
    onTraffic({ at: Date.now(), dir: 'out', message });
    return send(message, options);
  };
  // The client sets onmessage when it connects; wrap whatever it sets.
  let handler: ((m: JSONRPCMessage) => void) | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: (fn: ((m: JSONRPCMessage) => void) | undefined) => {
      handler = fn
        ? (m: JSONRPCMessage) => {
            onTraffic({ at: Date.now(), dir: 'in', message: m });
            fn(m);
          }
        : undefined;
    },
  });
}

export const textOf = (r: ToolResult) =>
  r.content
    .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
    .join(' ')
    .trim();
