// The readiness report: what an Alexa+ add-on (an MCP server) should get right, checked against a
// live server. The rules come from the MCP spec (2025-11-25), the MCP Apps extension, and what a
// voice-first screen needs. They are this project's checklist, not an Amazon certification.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type ServerSnapshot, type ToolResult, taskSupportOf, uiResourceOf, visibilityOf } from './mcp';

export type Level = 'pass' | 'warn' | 'fail' | 'info';
export interface Check {
  id: string;
  level: Level;
  title: string;
  detail?: string;
  /** Tool names this check is about, if any. */
  tools?: string[];
}

export const MIN_PROTOCOL = '2025-11-25';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** Words that are comfortable to hear in one reply; the screen can show the rest. */
export const SPOKEN_WORDS = 40;

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const list = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

/** Everything that can be checked from the server's answers to initialize, tools/list and resources/read. */
export function checkServer(s: ServerSnapshot): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // --- Protocol and transport
  if (!s.protocolVersion) add({ id: 'protocol', level: 'fail', title: 'No protocol version was agreed', detail: 'The server did not answer initialize with a protocolVersion.' });
  else if (s.protocolVersion < MIN_PROTOCOL)
    add({ id: 'protocol', level: 'fail', title: `MCP ${s.protocolVersion} is older than ${MIN_PROTOCOL}`, detail: `Alexa+ add-ons implement MCP ${MIN_PROTOCOL} or later. Update your MCP SDK.` });
  else add({ id: 'protocol', level: 'pass', title: `MCP ${s.protocolVersion} over Streamable HTTP` });
  add(
    s.sessionId
      ? { id: 'session', level: 'info', title: 'Stateful: the server keeps a session', detail: 'Sessions are lost when the server restarts; clients reconnect with a new one. Keep anything that matters (a task, a payment) in storage, not in the session.' }
      : { id: 'session', level: 'info', title: 'Stateless: no session id', detail: 'Every request stands alone, which scales easily. Tasks and server-to-client requests (elicitation) need a session.' },
  );

  // --- Who the server is
  const info = s.serverInfo ?? {};
  if (!info.name) add({ id: 'identity', level: 'fail', title: 'The server has no name', detail: 'Set serverInfo.name in initialize.' });
  else {
    const missing = [!info.title && 'a title', !info.description && 'a description', !info.version && 'a version'].filter(Boolean) as string[];
    add(
      missing.length
        ? { id: 'identity', level: 'warn', title: `"${info.title ?? info.name}" has no ${missing.join(' or ')}`, detail: 'A host shows the title and description when someone enables your add-on.' }
        : { id: 'identity', level: 'pass', title: `${info.title} ${info.version}`, detail: info.description },
    );
  }
  if (!s.instructions?.trim()) add({ id: 'instructions', level: 'warn', title: 'No instructions for the assistant', detail: 'initialize can return instructions: how and when the assistant should use your tools. Alexa+ passes them to its model.' });
  else if (s.instructions.length > 4000) add({ id: 'instructions', level: 'warn', title: `Long instructions (${s.instructions.length} characters)`, detail: 'Every turn pays for them. Keep the rules that matter; put details in tool descriptions.' });
  else add({ id: 'instructions', level: 'pass', title: 'Has instructions for the assistant', detail: `${s.instructions.length} characters` });

  // --- Tools
  const tools = s.tools;
  if (!tools.length) add({ id: 'tools', level: 'fail', title: 'No tools', detail: 'An add-on does its work through tools. tools/list returned none.' });
  else add({ id: 'tools', level: tools.length > 40 ? 'warn' : 'pass', title: `${tools.length} tool${tools.length === 1 ? '' : 's'}`, detail: tools.length > 40 ? 'Many tools make it harder for the assistant to choose; merge similar ones.' : undefined });
  const badNames = tools.filter((t) => !NAME.test(t.name)).map((t) => t.name);
  if (badNames.length) add({ id: 'tool-names', level: 'fail', title: 'Tool names that hosts may reject', detail: 'Use 1–64 letters, digits, _ . or -.', tools: badNames });
  const modelTools = tools.filter((t) => visibilityOf(t).includes('model'));
  const noDescription = modelTools.filter((t) => !t.description?.trim()).map((t) => t.name);
  if (noDescription.length) add({ id: 'descriptions', level: 'warn', title: `${noDescription.length} tool${noDescription.length === 1 ? ' has' : 's have'} no description`, detail: 'The assistant picks tools by their descriptions: say what it does and when to use it.', tools: noDescription });
  const longDescription = modelTools.filter((t) => (t.description?.length ?? 0) > 1200).map((t) => t.name);
  if (longDescription.length) add({ id: 'long-descriptions', level: 'warn', title: 'Very long tool descriptions', detail: 'Over 1,200 characters. Keep the when-to-use; move background to the instructions.', tools: longDescription });
  const undocumented = modelTools.filter((t) => paramsWithoutDescription(t).length).map((t) => `${t.name} (${paramsWithoutDescription(t).join(', ')})`);
  if (undocumented.length) add({ id: 'params', level: 'warn', title: 'Parameters without a description', detail: 'Describe each parameter: what it is, its format, an example. The assistant fills them from speech.', tools: undocumented });
  const noHints = tools.filter((t) => t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined).map((t) => t.name);
  if (noHints.length)
    add({ id: 'annotations', level: 'info', title: `${noHints.length} tool${noHints.length === 1 ? '' : 's'} without safety hints`, detail: 'readOnlyHint (only reads) or destructiveHint (changes or deletes) help a host decide when to confirm with the person first.', tools: noHints });
  if (tools.length && !noDescription.length && !badNames.length) add({ id: 'tools-described', level: 'pass', title: 'Every tool the assistant can call is named and described' });
  const appOnly = tools.filter((t) => !visibilityOf(t).includes('model')).map((t) => t.name);
  if (appOnly.length) add({ id: 'app-only', level: 'info', title: 'Tools only cards may call', detail: 'MCP Apps visibility ["app"]: hidden from the assistant, callable from your cards.', tools: appOnly });
  const tasks = tools.filter((t) => taskSupportOf(t) !== 'forbidden').map((t) => t.name);
  if (tasks.length) {
    const declared = Boolean((s.capabilities as { tasks?: unknown } | undefined)?.tasks);
    add(
      declared
        ? { id: 'tasks', level: 'pass', title: 'Long-running work runs as MCP tasks', tools: tasks, detail: 'Good for anything that waits on a person or a slow service: the conversation goes on meanwhile.' }
        : { id: 'tasks', level: 'fail', title: 'Tools offer tasks, but the server does not declare the tasks capability', tools: tasks },
    );
  }

  // --- MCP Apps (cards on the Echo Show screen)
  const withUi = tools.filter((t) => uiResourceOf(t));
  if (!withUi.length) add({ id: 'apps', level: 'info', title: 'No MCP Apps cards', detail: 'Echo Show has a screen: an MCP App (a ui:// resource) shows a tool result as a card instead of plain text.' });
  for (const r of s.resources) {
    const where = `${r.uri} (${list(r.tools)})`;
    if (r.error) {
      add({ id: `app:${r.uri}`, level: 'fail', title: `Card ${r.uri} could not be read`, detail: r.error, tools: r.tools });
      continue;
    }
    const mime = (r.mimeType ?? '').replace(/\s+/g, '').toLowerCase();
    if (mime !== MCP_APP_MIME) add({ id: `app-mime:${r.uri}`, level: 'warn', title: `Card ${r.uri} is not served as ${MCP_APP_MIME}`, detail: `It says ${r.mimeType ?? 'nothing'}. MCP Apps hosts look for this type.`, tools: r.tools });
    if ((r.size ?? 0) > 400_000) add({ id: `app-size:${r.uri}`, level: 'warn', title: `Card ${r.uri} is ${Math.round((r.size ?? 0) / 1000)} KB`, detail: 'Large cards load slowly on a device; split out what the first screen does not need.', tools: r.tools });
    const external = externalOrigins(r.html ?? '');
    const declared = declaredDomains(r.meta);
    const undeclared = external.filter((o) => !declared.some((d) => o === d || o.endsWith(d.replace(/^\*\./, '.'))));
    if (undeclared.length)
      add({ id: `app-csp:${r.uri}`, level: 'warn', title: `Card ${r.uri} loads from origins it does not declare`, detail: `${list(undeclared)}. Hosts render cards in a sandbox with a content security policy; list them in _meta.ui.csp (resourceDomains or connectDomains).`, tools: r.tools });
    else if (!r.error) add({ id: `app-ok:${r.uri}`, level: 'pass', title: `Card ${where} reads correctly`, detail: `${Math.round((r.size ?? 0) / 100) / 10} KB${declared.length ? `, declares ${list(declared)}` : ''}` });
  }

  // --- Speed (a voice reply waits for these)
  const { initializeMs, listToolsMs } = s.timings;
  const slow = initializeMs > 1500 || listToolsMs > 1000;
  add({
    id: 'latency',
    level: slow ? 'warn' : 'pass',
    title: `Connected in ${Math.round(initializeMs)} ms, tools listed in ${Math.round(listToolsMs)} ms`,
    detail: slow ? 'Someone is waiting for a spoken answer. A free host that sleeps when idle adds a minute to the first request: keep it warm.' : undefined,
  });
  return out;
}

/** What one tool call says about the add-on: speakable text, length, time, errors. */
export function checkResult(tool: Tool | undefined, result: ToolResult, ms: number): Check[] {
  const out: Check[] = [];
  const name = tool?.name ?? 'tool';
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();
  const words = text ? text.split(/\s+/).length : 0;
  if (result.isError) out.push({ id: `run-error:${name}`, level: 'info', title: `${name} returned an error`, detail: text || 'No message. Say what went wrong in words someone can act on.', tools: [name] });
  if (!text) out.push({ id: `run-text:${name}`, level: 'warn', title: `${name} returned no text`, detail: 'A voice device needs words to say, even when a card shows the details.', tools: [name] });
  else if (words > SPOKEN_WORDS) out.push({ id: `run-long:${name}`, level: 'warn', title: `${name} says ${words} words`, detail: `More than about ${SPOKEN_WORDS} words is a lot to hear at once. Say the answer first; put the rest on the card.`, tools: [name] });
  else out.push({ id: `run-text:${name}`, level: 'pass', title: `${name} answers in ${words} words`, tools: [name] });
  if (ms > 3000) out.push({ id: `run-slow:${name}`, level: 'warn', title: `${name} took ${(ms / 1000).toFixed(1)} s`, detail: 'Over 3 seconds of silence feels broken on a voice device. Run slow work as a task, or answer first and finish later.', tools: [name] });
  if (tool && result.structuredContent === undefined && (tool as { outputSchema?: unknown }).outputSchema) out.push({ id: `run-structured:${name}`, level: 'fail', title: `${name} declares an outputSchema but returned no structuredContent`, tools: [name] });
  return out;
}

export function paramsWithoutDescription(tool: Tool): string[] {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
  return Object.entries(props)
    .filter(([, p]) => !p?.description?.trim())
    .map(([k]) => k);
}

/** Origins a card's HTML loads from directly (scripts, styles, images, fetch calls in the page). */
export function externalOrigins(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"'\s>]+)/gi)) found.add(origin(m[1]));
  for (const m of html.matchAll(/(?:fetch|import)\s*\(\s*["'](https?:\/\/[^"'\s)]+)/gi)) found.add(origin(m[1]));
  for (const m of html.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi)) found.add(origin(m[1]));
  found.delete('');
  return [...found].sort();
}

function origin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Domains a card declares in _meta.ui.csp (resourceDomains, connectDomains, frameDomains). */
export function declaredDomains(meta: Record<string, unknown> | undefined): string[] {
  const csp = (meta?.ui as { csp?: Record<string, unknown> } | undefined)?.csp ?? {};
  return Object.values(csp)
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .filter((v): v is string => typeof v === 'string')
    .map((v) => origin(v) || v);
}

/** Pass, warn, fail counts for the report's header. */
export function tally(checks: Check[]) {
  return checks.reduce((acc, c) => ({ ...acc, [c.level]: acc[c.level] + 1 }), { pass: 0, warn: 0, fail: 0, info: 0 } as Record<Level, number>);
}

export const CATEGORIES = ['Protocol', 'Tools', 'Cards', 'Voice', 'Speed', 'Robustness'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Which part of the add-on a check is about. */
export function categoryOf(id: string): Category {
  const key = id.replace(/:.*/, '');
  if (key === 'protocol' || key === 'session' || key === 'identity') return 'Protocol';
  if (key.startsWith('app') || key.startsWith('card') || key.startsWith('probe')) return 'Cards';
  if (key === 'latency' || key === 'run-slow') return 'Speed';
  if (key.startsWith('run-')) return 'Voice';
  if (key.startsWith('conf')) return 'Robustness';
  return 'Tools';
}

/**
 * A score out of 100 for each part, and overall: each part starts at 100, loses 35 for each thing to
 * fix and 12 for each thing to improve. Parts with nothing checked yet are left out.
 */
export function score(checks: Check[]): { overall: number | null; parts: Array<{ category: Category; score: number | null; fail: number; warn: number }> } {
  const parts = CATEGORIES.map((category) => {
    const mine = checks.filter((c) => categoryOf(c.id) === category && c.level !== 'info');
    const fail = mine.filter((c) => c.level === 'fail').length;
    const warn = mine.filter((c) => c.level === 'warn').length;
    return { category, score: mine.length ? Math.max(0, 100 - fail * 35 - warn * 12) : null, fail, warn };
  });
  const scored = parts.filter((p) => p.score !== null) as Array<{ score: number }>;
  return { overall: scored.length ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length) : null, parts };
}
