import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Assistant, cleanSchema, forModel, modelTools } from '../src/assistant';
import { type Check, categoryOf, score } from '../src/checks';
import { runConformance, safeToolForBadArgs, type Target } from '../src/conformance';
import { probeChecks, withProbe, type ProbeMetrics } from '../src/probe';
import { reportMarkdown } from '../src/report';
import type { ServerSnapshot, ToolResult } from '../src/mcp';

const tool = (over: Partial<Tool> & { name: string }): Tool => ({ inputSchema: { type: 'object', properties: {} }, ...over }) as Tool;
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

// ---------- score ----------
test('the score: each part starts at 100, loses 35 per thing to fix and 12 per thing to improve', () => {
  const checks: Check[] = [
    { id: 'protocol', level: 'pass', title: '' },
    { id: 'descriptions', level: 'warn', title: '' },
    { id: 'tool-names', level: 'fail', title: '' },
    { id: 'app-mime:ui://x', level: 'warn', title: '' },
    { id: 'annotations', level: 'info', title: 'info does not count' },
  ];
  const s = score(checks);
  const part = (c: string) => s.parts.find((p) => p.category === c)!.score;
  assert.equal(part('Protocol'), 100);
  assert.equal(part('Tools'), 53);
  assert.equal(part('Cards'), 88);
  assert.equal(part('Voice'), null, 'nothing checked yet');
  assert.equal(s.overall, Math.round((100 + 53 + 88) / 3));
  assert.equal(score([]).overall, null);
});

test('every kind of check lands in its part', () => {
  assert.equal(categoryOf('probe-text:ui://a'), 'Cards');
  assert.equal(categoryOf('run-slow:x'), 'Speed');
  assert.equal(categoryOf('run-long:x'), 'Voice');
  assert.equal(categoryOf('conf-ping'), 'Robustness');
  assert.equal(categoryOf('latency'), 'Speed');
  assert.equal(categoryOf('params'), 'Tools');
});

// ---------- the card audit ----------
const metrics = (over: Partial<ProbeMetrics> = {}): ProbeMetrics => ({ viewport: { width: 1280, height: 720 }, textBySize: { '28': 400, '20': 100 }, lowContrast: [], smallTargets: [], targets: 3, overflow: { x: 0, y: 0 }, ...over });

test('a card that reads well from across the room passes', () => {
  const checks = probeChecks('ui://a', metrics(), true);
  assert.ok(checks.every((c) => c.level === 'pass'), JSON.stringify(checks));
});

test('small text, low contrast, small targets and a card that does not fit are pointed out', () => {
  const checks = probeChecks('ui://a', metrics({ textBySize: { '12': 300, '28': 100 }, lowContrast: [{ text: 'Grey on grey', ratio: 2.1, size: 14 }], smallTargets: [{ label: 'Close', width: 30, height: 30 }], overflow: { x: 0, y: 140 } }), true);
  const byKind = (k: string) => checks.find((c) => c.id.startsWith(k))!;
  assert.match(byKind('probe-text').title, /75% of the text/);
  assert.match(byKind('probe-contrast').detail!, /Grey on grey” 2\.1:1/);
  assert.match(byKind('probe-targets').title, /1 of 3 touch targets/);
  assert.match(byKind('probe-fit').detail!, /140 px too tall/);
  assert.equal(probeChecks('ui://a', metrics({ overflow: { x: 0, y: 140 } }), false).find((c) => c.id.startsWith('probe-fit')), undefined, 'an inline card may grow');
});

test('the audit script goes first in the card, which is otherwise unchanged', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
  const out = withProbe(html);
  assert.ok(out.indexOf('sim-probe') < out.indexOf('<title>'));
  assert.equal(out.replace(/<script>\(function \(\) \{[\s\S]*?\}\)\(\);<\/script>/, ''), html);
  assert.ok(withProbe('<p>no head</p>').endsWith('<p>no head</p>'));
});

// ---------- robustness tests ----------
const err = (code: number, message = 'x') => Object.assign(new Error(message), { code });
const fakeTarget = (over: Partial<Target> = {}): Target => ({
  request: async (m) => {
    if (m === 'ping') return {};
    if (m === 'resources/list') return { resources: [] };
    throw err(-32601, 'Method not found');
  },
  call: async (name, args) => {
    if (name === 'simulator_no_such_tool') throw err(-32602, 'Unknown tool');
    if (name === 'find' && !('item' in args)) return { content: [{ type: 'text', text: 'item is required' }], isError: true };
    return ok('done');
  },
  tools: [tool({ name: 'find', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } }), tool({ name: 'delete_all', annotations: { destructiveHint: true }, inputSchema: { type: 'object', properties: { really: { type: 'boolean' } }, required: ['really'] } })],
  capabilities: { tools: {}, resources: {} },
  endpoint: 'http://test/mcp',
  headers: {},
  sessionId: 'abc',
  protocolVersion: '2025-11-25',
  fetchImpl: (async (_u: string, init?: RequestInit) => new Response(init?.method === 'GET' ? 'data: x\n\n' : 'Session not found', { status: init?.method === 'GET' ? 200 : 404, headers: { 'content-type': init?.method === 'GET' ? 'text/event-stream' : 'text/plain' } })) as typeof fetch,
  ...over,
});

test('a well-behaved server passes every robustness test', async () => {
  const checks = await runConformance(fakeTarget());
  assert.deepEqual(
    checks.map((c) => [c.id, c.level]),
    [
      ['conf-ping', 'pass'],
      ['conf-method', 'pass'],
      ['conf-tool', 'pass'],
      ['conf-args', 'pass'],
      ['conf-resources', 'pass'],
      ['conf-parallel', 'pass'],
      ['conf-session', 'pass'],
      ['conf-stream', 'pass'],
    ],
  );
});

test('only a read-only tool is ever called with bad arguments', () => {
  assert.equal(safeToolForBadArgs(fakeTarget().tools)?.tool.name, 'find');
  assert.equal(safeToolForBadArgs([tool({ name: 'delete_all', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } })]), null);
});

test('what a sloppy server gets told', async () => {
  const checks = await runConformance(
    fakeTarget({
      request: async (m) => {
        if (m === 'ping') return {};
        throw err(-32000, 'nope');
      },
      call: async () => ok('sure'),
      fetchImpl: (async () => new Response('', { status: 400 })) as typeof fetch,
    }),
  );
  const level = (id: string) => checks.find((c) => c.id === id)?.level;
  assert.equal(level('conf-method'), 'warn');
  assert.equal(level('conf-tool'), 'fail', 'an unknown tool "worked"');
  assert.equal(level('conf-args'), 'fail', 'ran without its required argument');
  assert.equal(level('conf-resources'), 'fail');
  assert.equal(level('conf-session'), 'warn');
  assert.equal(level('conf-stream'), 'warn');
});

test('a second event stream refused with 409 is correct', async () => {
  const checks = await runConformance(fakeTarget({ fetchImpl: (async (_u: string, init?: RequestInit) => new Response('', { status: init?.method === 'GET' ? 409 : 404 })) as typeof fetch }));
  assert.equal(checks.find((c) => c.id === 'conf-stream')?.level, 'pass');
});

// ---------- the assistant ----------
const tools = [
  tool({ name: 'where_is', description: 'Finds where something is kept', inputSchema: { $schema: 'x', type: 'object', properties: { item: { type: 'string' } } } as Tool['inputSchema'] }),
  tool({ name: 'card_refresh', _meta: { ui: { visibility: ['app'] } } }),
];

test('the assistant only sees tools meant for the model, with clean schemas', () => {
  assert.deepEqual(modelTools(tools).map((t) => t.name), ['where_is']);
  assert.deepEqual(cleanSchema({ $schema: 'x', type: 'object', properties: { a: { $schema: 'y', type: 'string' } } }), { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(forModel({ content: [{ type: 'text', text: 'In the drawer' }], structuredContent: { where: 'drawer' } }), { text: 'In the drawer', data: { where: 'drawer' } });
  assert.deepEqual(forModel(undefined, 'boom'), { error: 'boom' });
});

test('Gemini: hears a sentence, calls the tool over MCP, and answers', async () => {
  const requests: any[] = [];
  const replies = [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'where_is', args: { item: 'EpiPen' }, id: 'c1' } }] } }] },
    { candidates: [{ content: { parts: [{ text: 'In the kitchen drawer.' }] } }] },
  ];
  const calls: unknown[] = [];
  const a = new Assistant({
    settings: { provider: 'gemini', apiKey: 'k', model: 'm', baseUrl: '' },
    tools,
    instructions: 'Be brief.',
    callTool: async (name, args) => (calls.push([name, args]), ok('EpiPen: kitchen drawer')),
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as typeof fetch,
  });
  const turn = await a.hear("Where's the EpiPen?");
  assert.equal(turn.reply, 'In the kitchen drawer.');
  assert.deepEqual(calls, [['where_is', { item: 'EpiPen' }]]);
  assert.match(requests[0].url, /models\/m:generateContent\?key=k$/);
  assert.match(requests[0].body.systemInstruction.parts[0].text, /Be brief\./);
  assert.deepEqual(requests[0].body.tools[0].functionDeclarations.map((f: any) => f.name), ['where_is']);
  assert.deepEqual(requests[1].body.contents.at(-1).parts[0].functionResponse, { name: 'where_is', id: 'c1', response: { text: 'EpiPen: kitchen drawer' } });
});

test('OpenAI-compatible: the same loop through chat completions, with the key as a bearer token', async () => {
  const requests: any[] = [];
  const replies = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'where_is', arguments: '{"item":"keys"}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'By the door.' } }] },
  ];
  const a = new Assistant({
    settings: { provider: 'openai', apiKey: 'sk', model: 'gpt', baseUrl: 'http://localhost:11434/v1/' },
    tools,
    callTool: async () => ok('Keys: hook by the door'),
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as typeof fetch,
  });
  const turn = await a.hear('Where are the keys?');
  assert.equal(turn.reply, 'By the door.');
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal((requests[0].headers as Record<string, string>).authorization, 'Bearer sk');
  assert.equal(requests[0].body.messages[0].role, 'system');
  assert.deepEqual(requests[1].body.messages.at(-1), { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ text: 'Keys: hook by the door' }) });
});

test('a model error is reported, not swallowed', async () => {
  const a = new Assistant({
    settings: { provider: 'gemini', apiKey: 'bad', model: 'm', baseUrl: '' },
    tools,
    callTool: async () => ok(''),
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })) as typeof fetch,
  });
  await assert.rejects(a.hear('hi'), /API key not valid/);
});

// ---------- the report ----------
test('the Markdown report has the score, the parts, and every check', () => {
  const snapshot = { url: 'https://x/mcp', protocolVersion: '2025-11-25', serverInfo: { name: 'pizza', title: 'Pizza Night' }, tools: [tool({ name: 'a' })], resources: [], timings: { initializeMs: 1, listToolsMs: 1 } } as ServerSnapshot;
  const md = reportMarkdown(snapshot, [{ id: 'protocol', level: 'pass', title: 'MCP 2025-11-25' }, { id: 'descriptions', level: 'warn', title: '1 tool has no description', tools: ['a'] }], new Date('2026-10-16T00:00:00Z'));
  assert.match(md, /^# Alexa\+ readiness: Pizza Night/);
  assert.match(md, /\*\*Score: 94\/100\*\* · MCP 2025-11-25 · 1 tools · 0 cards · 2026-10-16/);
  assert.match(md, /\| Tools \| 88 \| 0 \| 1 \|/);
  assert.match(md, /- ⚠️ \*\*1 tool has no description\*\* _\(a\)_/);
  assert.match(md, /not an Amazon certification/);
});
