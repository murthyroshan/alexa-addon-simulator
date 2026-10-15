// Robustness tests: what the server does when things go a little wrong, as a real assistant will
// make them. Only read-only tools are called with wrong arguments, so nothing in your service
// changes. Each test says what the MCP spec (2025-11-25) expects.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Check } from './checks';
import type { ToolResult } from './mcp';

export interface Target {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  tools: Tool[];
  capabilities?: Record<string, unknown>;
  endpoint: string;
  headers: Record<string, string>;
  sessionId?: string;
  protocolVersion?: string;
  fetchImpl?: typeof fetch;
}

const codeOf = (e: unknown) => (e as { code?: number })?.code;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const settle = async <T>(p: Promise<T>) => {
  try {
    return { ok: true as const, value: await p };
  } catch (error) {
    return { ok: false as const, error };
  }
};

/** A read-only tool with required arguments: safe to call with none. */
export function safeToolForBadArgs(tools: Tool[]): { tool: Tool; missing: string[] } | null {
  for (const t of tools) {
    const required = (t.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    if (t.annotations?.readOnlyHint === true && required.length) return { tool: t, missing: required };
  }
  return null;
}

export async function runConformance(t: Target): Promise<Check[]> {
  const out: Check[] = [];
  const f = t.fetchImpl ?? fetch;

  const ping = await settle(t.request('ping'));
  out.push(ping.ok ? { id: 'conf-ping', level: 'pass', title: 'Answers ping' } : { id: 'conf-ping', level: 'fail', title: 'ping failed', detail: `${messageOf(ping.error)}. Every MCP server must answer ping with an empty result.` });

  const unknown = await settle(t.request('simulator/no-such-method'));
  if (unknown.ok) out.push({ id: 'conf-method', level: 'fail', title: 'An unknown method was answered as if it worked', detail: 'It should be a JSON-RPC error -32601 (method not found).' });
  else if (codeOf(unknown.error) === -32601) out.push({ id: 'conf-method', level: 'pass', title: 'Unknown methods get -32601' });
  else out.push({ id: 'conf-method', level: 'warn', title: `Unknown methods get error ${codeOf(unknown.error) ?? '(no code)'}`, detail: 'JSON-RPC says -32601 (method not found), so clients can tell it from a server failure.' });

  const noTool = await settle(t.call('simulator_no_such_tool', {}));
  if (!noTool.ok) out.push({ id: 'conf-tool', level: 'pass', title: 'Calling a tool that does not exist is an error', detail: codeOf(noTool.error) === -32602 ? undefined : `Code ${codeOf(noTool.error) ?? 'none'}; the spec uses -32602 (unknown tool).` });
  else if (noTool.value.isError) out.push({ id: 'conf-tool', level: 'pass', title: 'Calling a tool that does not exist returns an error result' });
  else out.push({ id: 'conf-tool', level: 'fail', title: 'Calling a tool that does not exist "worked"', detail: 'Answer with an error, or the assistant thinks it did something.' });

  const safe = safeToolForBadArgs(t.tools);
  if (!safe) out.push({ id: 'conf-args', level: 'info', title: 'Wrong arguments: not tested', detail: 'No tool is both read-only (readOnlyHint) and has required arguments, so none can be called with bad arguments safely.' });
  else {
    const bad = await settle(t.call(safe.tool.name, {}));
    if (bad.ok && bad.value.isError) out.push({ id: 'conf-args', level: 'pass', title: `Missing arguments come back as a tool error (${safe.tool.name})`, detail: 'The assistant reads the message and tries again: what the 2025-11-25 spec asks for.' });
    else if (!bad.ok) out.push({ id: 'conf-args', level: 'warn', title: `Missing arguments are a protocol error (${safe.tool.name})`, detail: `${messageOf(bad.error)}. The 2025-11-25 spec asks servers to return input mistakes as tool errors (isError) so the model can correct itself.`, tools: [safe.tool.name] });
    else out.push({ id: 'conf-args', level: 'fail', title: `${safe.tool.name} ran without ${safe.missing.join(', ')}`, detail: 'Required arguments must be checked; a model will sometimes leave them out.', tools: [safe.tool.name] });
  }

  if (t.capabilities?.resources) {
    const res = await settle(t.request('resources/list'));
    out.push(res.ok ? { id: 'conf-resources', level: 'pass', title: 'Lists its resources' } : { id: 'conf-resources', level: 'fail', title: 'resources/list failed', detail: `${messageOf(res.error)}. The server declares the resources capability.` });
  }

  const started = performance.now();
  const many = await Promise.all(Array.from({ length: 5 }, () => settle(t.request('ping'))));
  const okCount = many.filter((m) => m.ok).length;
  out.push(
    okCount === 5
      ? { id: 'conf-parallel', level: 'pass', title: `Handles requests at the same time (5 in ${Math.round(performance.now() - started)} ms)` }
      : { id: 'conf-parallel', level: 'fail', title: `${5 - okCount} of 5 requests sent at once failed`, detail: 'An assistant and a card often ask at the same moment.' },
  );

  // Straight over HTTP: what the Streamable HTTP transport promises.
  const base = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(t.protocolVersion ? { 'mcp-protocol-version': t.protocolVersion } : {}), ...t.headers };
  if (t.sessionId) {
    const stale = await settle(f(t.endpoint, { method: 'POST', headers: { ...base, 'mcp-session-id': 'simulator-unknown-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }));
    const status = stale.ok ? stale.value.status : 0;
    out.push(
      status === 404
        ? { id: 'conf-session', level: 'pass', title: 'An unknown session gets 404', detail: 'Clients know to start a new session, as after a server restart.' }
        : { id: 'conf-session', level: 'warn', title: `An unknown session gets ${status || 'no answer'}`, detail: 'The spec says 404, so a client whose session was lost (a restart, a deploy) starts a new one instead of failing.' },
    );
    const abort = new AbortController();
    const stream = await settle(f(t.endpoint, { method: 'GET', headers: { ...t.headers, accept: 'text/event-stream', 'mcp-session-id': t.sessionId, ...(t.protocolVersion ? { 'mcp-protocol-version': t.protocolVersion } : {}) }, signal: abort.signal }));
    abort.abort();
    const s = stream.ok ? stream.value.status : 0;
    out.push(
      s === 200 && /event-stream/.test(stream.ok ? stream.value.headers.get('content-type') ?? '' : '')
        ? { id: 'conf-stream', level: 'pass', title: 'Opens an event stream for messages it sends first', detail: 'The server can notify the client (and ask it things) outside a request.' }
        : s === 409
          ? { id: 'conf-stream', level: 'pass', title: 'Keeps one event stream per session', detail: 'The simulator already has it open, so a second one is refused (409), as it should be.' }
          : s === 405
          ? { id: 'conf-stream', level: 'info', title: 'No standalone event stream (405)', detail: 'Allowed by the spec: the server only talks inside replies.' }
          : { id: 'conf-stream', level: 'warn', title: `GET for the event stream answered ${s || 'nothing'}`, detail: 'Expected 200 with text/event-stream, or 405 if the server has no stream.' },
    );
  }
  return out;
}
