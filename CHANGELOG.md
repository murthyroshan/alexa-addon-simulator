# Changelog

## 0.1.0 (2026-10-20)

The first release.

- **The simulator:** point it at any MCP server (Streamable HTTP) and use it the way Alexa+ would. Talk to it with your own model key (Gemini or OpenAI-compatible), see its MCP Apps cards on seven Echo screens, answer its forms and links (elicitation), and follow long-running tools as MCP tasks.
- **Readiness score:** out of 100, in six parts (Protocol, Tools, Cards, Voice, Speed, Robustness), each finding with why it matters and what to do. Copy it as Markdown.
- **Card audit:** text size, contrast, touch targets and fit, measured inside each card as it's drawn, after CSS zoom.
- **Robustness tests:** what MCP 2025-11-25 expects when things go a little wrong.
- **In CI:** `npm run check -- <url>` and a GitHub Action (`murthyroshan/alexa-addon-simulator@v0.1.0`) that fails the build below a minimum score and writes the report to the job summary. The card audit needs a browser, so it runs in the app only.
