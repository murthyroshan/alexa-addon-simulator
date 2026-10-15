#!/usr/bin/env node
// Serves the built simulator and its MCP proxy on this computer: npx alexa-addon-simulator
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxy } from './proxy.mjs';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const port = Number(process.env.PORT ?? 5174);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/proxy')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  const file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist + sep) && file !== join(dist, 'index.html')) return void res.writeHead(404).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // An unknown path is the app itself (it has a single page).
    try {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(await readFile(join(dist, 'index.html')));
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Build the simulator first: npm run build');
    }
  }
});

// This computer only: the proxy forwards requests anywhere, so it must not be reachable by others.
server.listen(port, '127.0.0.1', () => console.log(`Alexa+ add-on simulator: http://127.0.0.1:${port}`));
