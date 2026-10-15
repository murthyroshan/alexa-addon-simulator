# Alexa+ add-on simulator

**See your MCP server on an Echo Show before Alexa+ does.** Talk to it the way Alexa+ would, watch its MCP Apps cards on every Echo screen, and get a readiness score that tells you exactly what to fix.

Alexa+ add-ons are MCP servers, and access to real Alexa+ devices is limited. This simulator plays Alexa+'s part on your computer: an assistant that picks your tools from their descriptions, an Echo Show that renders your cards, forms and links when your server asks the person something, and a report on everything an add-on should get right.

```bash
git clone https://github.com/murthyroshan/alexa-addon-simulator
cd alexa-addon-simulator
npm install
npm run build
npm start            # http://127.0.0.1:5174
```

Paste your server's Streamable HTTP URL (for example `http://localhost:8787/mcp`), or try the example: [While You're Out](https://github.com/murthyroshan/while-youre-out), a babysitting add-on with MCP Apps cards, tasks and elicitation.

## What it does

| | |
| --- | --- |
| **Talk to it like Alexa+** | Type or speak a sentence. An assistant chooses your tools by their names and descriptions, calls them over MCP, shows the card and speaks a short reply, with the Echo Show light bar listening, thinking and speaking. Bring your own model: Gemini, or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio). Your key stays in your browser. |
| **Your cards on real screens** | MCP Apps (`ui://` resources) in a sandboxed frame on Echo Show 5, 8, 10, 15 (landscape and portrait), 21 and Echo Hub. Switch dark or light, the language, and inline or full screen, and watch your card adapt (`ui/notifications/host-context-changed`). |
| **Compare screens** | The same card on every Echo screen at once, each measured: does it fit, how much of the text is readable, are the touch targets big enough. |
| **From across the room** | See your card the way someone at the stove sees it. |
| **A card audit inside your card** | A small script measures what your card really draws: text under 18 px, contrast below WCAG 4.5:1 (see-through layers blended correctly), touch targets under 48 px, content that doesn't fit the screen. |
| **Readiness score** | Out of 100, in six parts: Protocol, Tools, Cards, Voice, Speed, Robustness. Every finding says why it matters and what to do. Copy the report as Markdown for a pull request. |
| **Robustness tests** | ping, an unknown method (-32601), an unknown tool, missing arguments (only on read-only tools, so nothing changes), five requests at once, a lost session (404) and the event stream: what MCP 2025-11-25 expects. |
| **Forms, links and tasks** | Elicitation forms on the screen, URL elicitation as a link and QR code, and long-running tools as MCP tasks with their status. Time the person spends answering is never counted as your server's time. |
| **Timeline** | Every turn as a waterfall (the model, your server, the person, speech), and every call's server time as a sparkline. |
| **Traffic** | Every JSON-RPC message, between the simulator and your server and between your card and the simulator. |
| **Command palette** | Ctrl+K: run any tool, switch device, run the tests, copy the report. |

## The local proxy

`npm start` serves the simulator together with a small proxy on `127.0.0.1`, so it can reach MCP servers that don't allow web pages to call them (CORS). The proxy forwards only what MCP needs (`content-type`, `accept`, `authorization`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`), never cookies, and streams server-sent events straight through. It listens on this computer only.

Without the proxy (for example `npm run dev` from another origin), your server has to allow the simulator's origin.

## What the checks are, and are not

The readiness checks are this project's own checklist, built from the MCP specification (2025-11-25), the MCP Apps extension, WCAG contrast and touch-target guidance, and rules of thumb for voice: a reply someone can listen to (about 40 words), and no long silences (3 seconds). They are not an Amazon certification, and passing them does not mean an add-on is approved.

Screen sizes are the CSS layout sizes a card sees on each device, approximately.

## How it works

| File | What it is |
| --- | --- |
| `src/mcp.ts` | The MCP client (official TypeScript SDK, Streamable HTTP, elicitation, tasks) with traffic capture |
| `src/AppFrame.tsx` | An MCP Apps host: `ui/initialize`, tool input and result, `tools/call` from cards (visibility `app` only), `ui/message`, `ui/open-link`, display modes |
| `src/assistant.ts` | The stand-in for the Alexa+ model: function calling with Gemini or OpenAI-compatible APIs |
| `src/checks.ts`, `src/conformance.ts`, `src/probe.ts` | The readiness checks, the robustness tests and the card audit |
| `src/report.ts` | The Markdown report |
| `server/proxy.mjs`, `server/start.mjs` | The local proxy and the static server |

```bash
npm test        # the checks, the audit, the robustness tests, the assistant loop, the proxy
npm run dev     # the simulator with hot reload (and the same proxy)
```

## License

[MIT](LICENSE)
