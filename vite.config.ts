import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error plain JavaScript module shared with server/start.mjs
import { proxy } from './server/proxy.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      // The same MCP proxy as `npm start`, during development.
      name: 'mcp-proxy',
      configureServer(server) {
        server.middlewares.use('/proxy', (req, res) => {
          req.url = `/proxy${req.url ?? ''}`;
          void proxy(req, res);
        });
      },
    },
  ],
  server: { port: 5174, host: '127.0.0.1' },
  build: {
    rolldownOptions: {
      output: {
        // React and the MCP client change rarely: separate files load in parallel and stay cached.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'mcp', test: /node_modules[\\/](@modelcontextprotocol|zod|ajv|eventsource-parser|pkce-challenge)/ },
          ],
        },
      },
    },
  },
});
