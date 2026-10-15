import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { checkResult, checkServer, declaredDomains, externalOrigins, paramsWithoutDescription, tally } from '../src/checks';
import type { ServerSnapshot } from '../src/mcp';

const tool = (over: Partial<Tool> & { name: string }): Tool => ({ inputSchema: { type: 'object', properties: {} }, ...over }) as Tool;

const good = (over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
  url: 'https://example.com/mcp',
  protocolVersion: '2025-11-25',
  serverInfo: { name: 'pizza', title: 'Pizza Night', version: '1.0.0', description: 'Orders pizza.' },
  capabilities: { tools: {} },
  instructions: 'Use order_pizza when someone wants pizza.',
  sessionId: 'abc',
  tools: [
    tool({
      name: 'order_pizza',
      description: 'Orders a pizza.',
      annotations: { destructiveHint: true },
      inputSchema: { type: 'object', properties: { size: { type: 'string', description: 'small, medium or large' } } },
      _meta: { ui: { resourceUri: 'ui://pizza/card.html' } },
    }),
  ],
  resources: [{ uri: 'ui://pizza/card.html', tools: ['order_pizza'], mimeType: 'text/html;profile=mcp-app', size: 2000, html: '<p>pizza</p>' }],
  timings: { initializeMs: 200, listToolsMs: 50 },
  ...over,
});

const byId = (checks: ReturnType<typeof checkServer>, id: string) => checks.find((c) => c.id === id || c.id.startsWith(`${id}:`));

test('a well-made server has nothing to fix', () => {
  const checks = checkServer(good());
  assert.equal(tally(checks).fail, 0);
  assert.equal(tally(checks).warn, 0, JSON.stringify(checks.filter((c) => c.level === 'warn')));
  assert.equal(byId(checks, 'protocol')?.level, 'pass');
});

test('an older protocol version must be fixed', () => {
  const c = byId(checkServer(good({ protocolVersion: '2025-06-18' })), 'protocol');
  assert.equal(c?.level, 'fail');
  assert.match(c!.title, /older than 2025-11-25/);
  assert.equal(byId(checkServer(good({ protocolVersion: '2026-03-01' })), 'protocol')?.level, 'pass', 'later versions are fine');
});

test('missing identity, instructions and descriptions are pointed out, by tool', () => {
  const checks = checkServer(
    good({
      serverInfo: { name: 'x' },
      instructions: undefined,
      tools: [tool({ name: 'a' }), tool({ name: 'b', description: 'B', inputSchema: { type: 'object', properties: { when: { type: 'string' } } } })],
      resources: [],
    }),
  );
  assert.equal(byId(checks, 'identity')?.level, 'warn');
  assert.equal(byId(checks, 'instructions')?.level, 'warn');
  assert.deepEqual(byId(checks, 'descriptions')?.tools, ['a']);
  assert.deepEqual(byId(checks, 'params')?.tools, ['b (when)']);
  assert.deepEqual(byId(checks, 'annotations')?.tools, ['a', 'b']);
});

test('bad tool names fail; app-only tools need no description', () => {
  const checks = checkServer(good({ tools: [tool({ name: 'has space' }), tool({ name: 'card_refresh', _meta: { ui: { visibility: ['app'] } } })], resources: [] }));
  assert.deepEqual(byId(checks, 'tool-names')?.tools, ['has space']);
  assert.deepEqual(byId(checks, 'descriptions')?.tools, ['has space']);
  assert.deepEqual(byId(checks, 'app-only')?.tools, ['card_refresh']);
});

test('tasks must be declared as a capability', () => {
  const tasky = tool({ name: 'ask_parent', description: 'Waits for a parent.', execution: { taskSupport: 'optional' } } as Partial<Tool> & { name: string });
  assert.equal(byId(checkServer(good({ tools: [tasky], resources: [] })), 'tasks')?.level, 'fail');
  assert.equal(byId(checkServer(good({ tools: [tasky], resources: [], capabilities: { tasks: {} } })), 'tasks')?.level, 'pass');
});

test('cards: the MCP Apps type, unreadable cards, and origins they load from without declaring', () => {
  const checks = checkServer(
    good({
      resources: [
        { uri: 'ui://a', tools: ['order_pizza'], mimeType: 'text/html', size: 10, html: '<img src="https://cdn.example.org/x.png">' },
        { uri: 'ui://b', tools: ['other'], error: 'Resource not found' },
        { uri: 'ui://c', tools: ['third'], mimeType: 'text/html;profile=mcp-app', html: '<script src="https://cdn.example.org/a.js"></script>', meta: { ui: { csp: { resourceDomains: ['https://cdn.example.org'] } } } },
      ],
    }),
  );
  assert.equal(byId(checks, 'app-mime:ui://a')?.level, 'warn');
  assert.match(byId(checks, 'app-csp:ui://a')!.detail!, /cdn\.example\.org/);
  assert.equal(byId(checks, 'app:ui://b')?.level, 'fail');
  assert.equal(byId(checks, 'app-csp:ui://c'), undefined, 'declared origins are fine');
  assert.equal(byId(checks, 'app-ok:ui://c')?.level, 'pass');
});

test('slow connections are flagged (someone is waiting for an answer)', () => {
  assert.equal(byId(checkServer(good({ timings: { initializeMs: 4000, listToolsMs: 100 } })), 'latency')?.level, 'warn');
  assert.equal(byId(checkServer(good()), 'latency')?.level, 'pass');
});

test('a result: words to say, not too many, and not too slow', () => {
  const t = tool({ name: 'order_pizza' });
  assert.equal(checkResult(t, { content: [{ type: 'text', text: 'Your pizza is on its way.' }] }, 300)[0].level, 'pass');
  assert.equal(checkResult(t, { content: [] }, 300)[0].level, 'warn');
  const long = checkResult(t, { content: [{ type: 'text', text: 'word '.repeat(60) }] }, 300);
  assert.match(long[0].title, /says 60 words/);
  assert.ok(checkResult(t, { content: [{ type: 'text', text: 'ok' }] }, 5000).some((c) => c.id.startsWith('run-slow')));
  const structured = tool({ name: 's', outputSchema: { type: 'object' } } as Partial<Tool> & { name: string });
  assert.ok(checkResult(structured, { content: [{ type: 'text', text: 'ok' }] }, 10).some((c) => c.level === 'fail'));
});

test('helpers: undescribed parameters, origins in HTML, declared CSP domains', () => {
  assert.deepEqual(paramsWithoutDescription(tool({ name: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string', description: 'B' } } } })), ['a']);
  assert.deepEqual(externalOrigins(`<link href="https://fonts.example.com/a.css"><img src='https://img.example.com/b.png'><script>fetch("https://api.example.com/x")</script><div style="background:url(https://img.example.com/c.png)">`), [
    'https://api.example.com',
    'https://fonts.example.com',
    'https://img.example.com',
  ]);
  assert.deepEqual(declaredDomains({ ui: { csp: { connectDomains: ['https://api.example.com/v1'], resourceDomains: ['https://img.example.com'] } } }), ['https://api.example.com', 'https://img.example.com']);
});
