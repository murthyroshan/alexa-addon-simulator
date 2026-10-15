// A small pass-through for MCP traffic, so the simulator (a web page) can reach any MCP server,
// including ones that don't allow browser pages to call them (CORS). The page asks this proxy on
// its own origin; the proxy forwards the request and streams the answer back, server-sent events
// included. It runs on this computer only (127.0.0.1).

/** Request headers MCP needs, forwarded as they are. Everything else (cookies...) stays here. */
export const REQUEST_HEADERS = ['content-type', 'accept', 'authorization', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
/** Response headers the page needs back. */
export const RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

/** The MCP server a proxied request is for: an http(s) URL in ?target=, or null. */
export function targetOf(requestUrl) {
  const target = new URL(requestUrl, 'http://local').searchParams.get('target');
  if (!target) return null;
  try {
    const u = new URL(target);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function pick(headers, names) {
  const out = {};
  for (const name of names) {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    if (value) out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Handles one /proxy request (Node's http request and response). */
export async function proxy(req, res, fetchImpl = fetch) {
  const target = targetOf(req.url);
  if (!target) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ error: 'Add ?target= with the http(s) URL of your MCP server.' }));
  }
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  // If the page goes away (a closed event stream), stop waiting for the server too.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let upstream;
  try {
    upstream = await fetchImpl(target, { method: req.method, headers: pick(req.headers, REQUEST_HEADERS), body, signal: abort.signal, redirect: 'manual' });
  } catch (e) {
    if (abort.signal.aborted) return;
    res.writeHead(502, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ error: `Could not reach ${new URL(target).host}: ${e instanceof Error ? e.message : e}` }));
  }
  res.writeHead(upstream.status, pick(upstream.headers, RESPONSE_HEADERS));
  if (!upstream.body) return void res.end();
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {
    // the page or the server closed the stream
  }
  res.end();
}
