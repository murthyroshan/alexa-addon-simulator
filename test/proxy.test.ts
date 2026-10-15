import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
// @ts-expect-error plain JavaScript module
import { pick, proxy, targetOf } from '../server/proxy.mjs';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

test('only http(s) targets are proxied', () => {
  assert.equal(targetOf('/proxy?target=https%3A%2F%2Fexample.com%2Fmcp'), 'https://example.com/mcp');
  assert.equal(targetOf('/proxy?target=file%3A%2F%2F%2Fetc%2Fpasswd'), null);
  assert.equal(targetOf('/proxy?target=not%20a%20url'), null);
  assert.equal(targetOf('/proxy'), null);
});

test('only the headers MCP needs pass through (no cookies)', () => {
  assert.deepEqual(pick({ 'content-type': 'application/json', cookie: 'secret=1', 'mcp-session-id': 's1', authorization: 'Bearer t' }, ['content-type', 'authorization', 'mcp-session-id', 'cookie-not-listed']), {
    'content-type': 'application/json',
    authorization: 'Bearer t',
    'mcp-session-id': 's1',
  });
});

test('a request goes through to the MCP server and its event stream comes back', async () => {
  let seen: { method?: string; headers?: Record<string, unknown>; body?: string } = {};
  const upstream = await listen(
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1', 'set-cookie': 'tracking=1' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        res.end();
      });
    }),
  );
  const local = await listen(createServer((req, res) => void proxy(req, res)));
  const r = await fetch(`${local}/proxy?target=${encodeURIComponent(`${upstream}/mcp`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: 'mine=1', 'mcp-protocol-version': '2025-11-25' },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 'sess-1');
  assert.equal(r.headers.get('set-cookie'), null, "the server's cookies stay out");
  assert.match(await r.text(), /"result":\{\}/);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(seen.headers?.['mcp-protocol-version'], '2025-11-25');
  assert.equal(seen.headers?.cookie, undefined, "the page's cookies stay out");
});

test('an unreachable server is a clear 502, a missing target a 400', async () => {
  const local = await listen(createServer((req, res) => void proxy(req, res)));
  const bad = await fetch(`${local}/proxy?target=${encodeURIComponent('http://127.0.0.1:1/mcp')}`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /Could not reach 127\.0\.0\.1:1/);
  assert.equal((await fetch(`${local}/proxy`)).status, 400);
});
