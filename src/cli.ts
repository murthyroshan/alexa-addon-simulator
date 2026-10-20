// The readiness check without a browser, for CI: connect to an MCP server the way Alexa+ would, run the
// protocol, tool and robustness checks, and print the score. The card audit needs a browser, so it runs in
// the app only; here Cards covers what the server declares (the MCP App resources and their sizes).
//   npx tsx src/cli.ts https://example.com/mcp [--min-score 80] [--header "Authorization: Bearer x"] [--report report.md]
import { appendFileSync, writeFileSync } from 'node:fs';
import { checkServer, score, type Check } from './checks';
import { runConformance } from './conformance';
import { Connection } from './mcp';
import { reportMarkdown } from './report';

interface Options {
  url: string;
  minScore: number;
  headers: Record<string, string>;
  report?: string;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Options {
  const headers: Record<string, string> = {};
  const addHeader = (h: string) => {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  };
  // Headers can also come from the environment, one per line, so secrets stay out of the command line.
  for (const line of (env.READINESS_HEADERS ?? '').split(/\r?\n/)) if (line.trim()) addHeader(line);
  let url = '';
  let minScore = 0;
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-score') minScore = Number(argv[++i]);
    else if (a === '--header') addHeader(argv[++i] ?? '');
    else if (a === '--report') report = argv[++i];
    else if (!a.startsWith('--')) url = a;
  }
  if (!url) throw new Error('Usage: alexa-addon-check <mcp-url> [--min-score 80] [--header "Name: value"] [--report report.md]');
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new Error('--min-score is a number from 0 to 100');
  return { url, minScore, headers, report };
}

const MARK: Record<Check['level'], string> = { pass: 'good   ', warn: 'improve', fail: 'FIX    ', info: 'note   ' };

export async function check(opts: Options): Promise<{ overall: number | null; checks: Check[]; markdown: string }> {
  const conn = await Connection.open(opts.url, { headers: opts.headers });
  try {
    const robustness = await runConformance({
      request: (m, p) => conn.request(m, p),
      call: (n, a) => conn.call(n, a),
      tools: conn.snapshot.tools,
      capabilities: conn.snapshot.capabilities,
      endpoint: conn.endpoint,
      headers: conn.headers,
      sessionId: conn.sessionId,
      protocolVersion: conn.snapshot.protocolVersion,
    });
    const checks = [...checkServer(conn.snapshot), ...robustness];
    const markdown = reportMarkdown(conn.snapshot, checks);
    return { overall: score(checks).overall, checks, markdown };
  } finally {
    await conn.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const { overall, checks, markdown } = await check(opts);
  const parts = score(checks).parts;
  console.log(`\nReadiness ${overall ?? '-'} / 100   ${opts.url}`);
  console.log(parts.map((p) => `${p.category} ${p.score ?? '-'}`).join('   '));
  console.log('(The card audit runs in the app, where cards are drawn on each Echo screen.)\n');
  for (const c of checks.filter((c) => c.level !== 'pass')) console.log(`${MARK[c.level]}  ${c.title}${c.detail ? `\n          ${c.detail}` : ''}`);
  if (opts.report) writeFileSync(opts.report, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  if (overall !== null && overall < opts.minScore) {
    console.error(`\nReadiness ${overall} is below the minimum of ${opts.minScore}.`);
    process.exit(1);
  }
}

if (process.argv[1] && /cli\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
