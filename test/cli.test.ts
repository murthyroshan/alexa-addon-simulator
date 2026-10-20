import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { check, parseArgs } from '../src/cli';

test('arguments: the URL, a minimum score, headers from flags and from the environment', () => {
  const o = parseArgs(['https://x.test/mcp', '--min-score', '85', '--header', 'X-One: 1', '--report', 'r.md'], { READINESS_HEADERS: 'Authorization: Bearer t\nX-Two: 2' });
  assert.equal(o.url, 'https://x.test/mcp');
  assert.equal(o.minScore, 85);
  assert.equal(o.report, 'r.md');
  assert.deepEqual(o.headers, { Authorization: 'Bearer t', 'X-Two': '2', 'X-One': '1' });
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['https://x.test/mcp', '--min-score', '120']), /0 to 100/);
});

// A tiny MCP server over Streamable HTTP, one session per client, the way a real add-on runs.
async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http: Server = createServer(async (req, res) => {
    const id = req.headers['mcp-session-id'] as string | undefined;
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      if (id) return void res.writeHead(404).end();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => void sessions.set(sid, transport!) });
      const mcp = new McpServer({ name: 'tiny', version: '1.0.0' }, { instructions: 'Answers what time the shop opens.' });
      mcp.registerTool(
        'opening_hours',
        { title: 'Opening hours', description: 'When the shop opens on a given day', inputSchema: { day: z.string().describe('A day of the week') }, annotations: { readOnlyHint: true } },
        async ({ day }) => ({ content: [{ type: 'text', text: `${day}: 9 to 5.` }] }),
      );
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => http.close(() => r())) };
}

test('a whole check against a real MCP server: a score, the checks, and a Markdown report', async () => {
  const s = await serve();
  try {
    const r = await check({ url: s.url, minScore: 0, headers: {} });
    assert.ok(r.overall !== null && r.overall >= 0 && r.overall <= 100);
    assert.ok(r.checks.some((c) => c.id.startsWith('protocol')));
    assert.ok(r.checks.length > 5, 'protocol, tool and robustness checks');
    assert.match(r.markdown, /^# Alexa\+ readiness: tiny/m);
    assert.match(r.markdown, /1 tool · 0 cards/);
  } finally {
    await s.close();
  }
});
