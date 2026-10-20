// The readiness report as Markdown: paste it into a pull request, an issue or your notes.
import { type Check, CATEGORIES, categoryOf, score } from './checks';
import type { ServerSnapshot } from './mcp';

const ICON = { fail: '❌', warn: '⚠️', pass: '✅', info: 'ℹ️' } as const;

export function reportMarkdown(s: ServerSnapshot, checks: Check[], when = new Date()): string {
  const sc = score(checks);
  const name = s.serverInfo?.title ?? s.serverInfo?.name ?? s.url;
  const lines = [
    `# Alexa+ readiness: ${name}`,
    '',
    `**Score: ${sc.overall ?? '–'}/100** · MCP ${s.protocolVersion ?? 'unknown'} · ${s.tools.length} ${s.tools.length === 1 ? 'tool' : 'tools'} · ${s.resources.length} ${s.resources.length === 1 ? 'card' : 'cards'} · ${when.toISOString().slice(0, 10)}`,
    '',
    `Server: \`${s.url}\``,
    '',
    '| Part | Score | To fix | To improve |',
    '| --- | --- | --- | --- |',
    ...sc.parts.filter((p) => p.score !== null).map((p) => `| ${p.category} | ${p.score} | ${p.fail} | ${p.warn} |`),
    '',
  ];
  for (const category of CATEGORIES) {
    const mine = checks.filter((c) => categoryOf(c.id) === category);
    if (!mine.length) continue;
    lines.push(`## ${category}`, '');
    for (const level of ['fail', 'warn', 'pass', 'info'] as const)
      for (const c of mine.filter((x) => x.level === level)) {
        lines.push(`- ${ICON[level]} **${c.title}**${c.detail ? ` ${c.detail}` : ''}${c.tools?.length ? ` _(${c.tools.join(', ')})_` : ''}`);
      }
    lines.push('');
  }
  lines.push('_Checked with the Alexa+ add-on simulator. This is the project\'s own checklist (MCP spec 2025-11-25, MCP Apps, voice rules of thumb), not an Amazon certification._', '');
  return lines.join('\n');
}
