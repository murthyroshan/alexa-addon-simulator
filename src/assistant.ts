// Talk to your add-on: a stand-in for the Alexa+ assistant. It hears a sentence, picks your tools
// the way Alexa+ would (by their names, descriptions and your server's instructions), calls them
// over MCP, and answers in a short spoken reply. Bring your own model key: Gemini, or any
// OpenAI-compatible endpoint (OpenAI, OpenRouter, a local model through Ollama or LM Studio).
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type ToolResult, textOf, visibilityOf } from './mcp';

export type Provider = 'gemini' | 'openai';

export interface ModelSettings {
  provider: Provider;
  apiKey: string;
  model: string;
  /** OpenAI-compatible only: e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: string;
}

export const DEFAULT_MODELS: Record<Provider, string> = { gemini: 'gemini-flash-latest', openai: 'gpt-4.1-mini' };

export interface Step {
  kind: 'tool';
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  error?: string;
  ms: number;
}

export interface Turn {
  reply: string;
  steps: Step[];
}

export const SYSTEM = `You are Alexa+ on an Echo Show, a voice assistant with a screen, in someone's home. You are testing an add-on: an MCP server whose tools you can call.
- Use the add-on's tools to do what the person asks. Choose tools by their descriptions; fill arguments from what the person said.
- Never invent facts the tools didn't give you.
- When a tool answers, its card is already on the screen: say the answer in one or two short sentences, in the person's language. Don't read lists or long text aloud.
- If no tool fits, say so briefly.`;

type Json = Record<string, unknown>;

/** Strips what model APIs reject from a tool's JSON Schema ($schema keys). */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) if (k !== '$schema') out[k] = cleanSchema(v);
  return out;
}

/** The tools the assistant may call: everything visible to the model (not app-only tools). */
export const modelTools = (tools: Tool[]) => tools.filter((t) => visibilityOf(t).includes('model'));

/** What a tool's result looks like to the model: its words and its structured data. */
export function forModel(r: ToolResult | undefined, error?: string): Json {
  if (error) return { error };
  if (!r) return { error: 'No result' };
  return { text: textOf(r), ...(r.structuredContent ? { data: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
}

export interface AssistantDeps {
  settings: ModelSettings;
  tools: Tool[];
  instructions?: string;
  callTool: (name: string, args: Json) => Promise<ToolResult>;
  /** How to reach the model (through the page's proxy when there is one). */
  fetchImpl?: typeof fetch;
  route?: (url: string) => string;
  onStep?: (s: Step) => void;
  /** Each model call and tool call, for the turn's timeline. */
  onTiming?: (t: { kind: 'model' | 'tool'; label: string; start: number; end: number }) => void;
}

const MAX_ROUNDS = 4;

export class Assistant {
  private history: unknown[] = [];
  constructor(private deps: AssistantDeps) {}

  reset() {
    this.history = [];
  }

  async hear(text: string): Promise<Turn> {
    return this.deps.settings.provider === 'gemini' ? this.gemini(text) : this.openai(text);
  }

  private system() {
    return [SYSTEM, this.deps.instructions ? `The add-on's own instructions:\n${this.deps.instructions}` : ''].filter(Boolean).join('\n\n');
  }

  private async run(name: string, args: Json, steps: Step[]): Promise<Step> {
    const t0 = performance.now();
    const step: Step = { kind: 'tool', name, args, ms: 0 };
    try {
      step.result = await this.deps.callTool(name, args);
    } catch (e) {
      step.error = e instanceof Error ? e.message : String(e);
    }
    step.ms = performance.now() - t0;
    this.deps.onTiming?.({ kind: 'tool', label: name, start: t0, end: performance.now() });
    steps.push(step);
    this.deps.onStep?.(step);
    return step;
  }

  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
    const f = this.deps.fetchImpl ?? fetch;
    const t0 = performance.now();
    const res = await f(this.deps.route ? this.deps.route(url) : url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    this.deps.onTiming?.({ kind: 'model', label: this.deps.settings.model, start: t0, end: performance.now() });
    if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? `The model answered ${res.status}`);
    return json;
  }

  // ---------- Gemini (generateContent with function calling) ----------
  private async gemini(text: string): Promise<Turn> {
    const { settings } = this.deps;
    const steps: Step[] = [];
    this.history.push({ role: 'user', parts: [{ text }] });
    const functionDeclarations = modelTools(this.deps.tools).map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 1500), parametersJsonSchema: cleanSchema(t.inputSchema) }));
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
      const json = await this.post(
        url,
        {
          systemInstruction: { parts: [{ text: this.system() }] },
          contents: this.history,
          tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
          generationConfig: { temperature: 0.2 },
        },
        {},
      );
      const parts = (json.candidates?.[0]?.content?.parts ?? []) as Array<{ text?: string; functionCall?: { name: string; args?: Json; id?: string } }>;
      if (!parts.length) throw new Error(`The model gave no answer (${json.candidates?.[0]?.finishReason ?? 'unknown'}).`);
      this.history.push({ role: 'model', parts });
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) return { reply: parts.map((p) => p.text ?? '').join(' ').trim(), steps };
      const responses = [];
      for (const c of calls) {
        const s = await this.run(c.functionCall!.name, c.functionCall!.args ?? {}, steps);
        responses.push({ functionResponse: { name: c.functionCall!.name, id: c.functionCall!.id, response: forModel(s.result, s.error) } });
      }
      this.history.push({ role: 'user', parts: responses });
    }
    return { reply: lastWords(steps), steps };
  }

  // ---------- OpenAI-compatible (chat completions with tools) ----------
  private async openai(text: string): Promise<Turn> {
    const { settings } = this.deps;
    const steps: Step[] = [];
    if (!this.history.length) this.history.push({ role: 'system', content: this.system() });
    this.history.push({ role: 'user', content: text });
    const tools = modelTools(this.deps.tools).map((t) => ({ type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 1500), parameters: cleanSchema(t.inputSchema) } }));
    const base = settings.baseUrl.replace(/\/+$/, '') || 'https://api.openai.com/v1';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const json = await this.post(`${base}/chat/completions`, { model: settings.model, messages: this.history, tools: tools.length ? tools : undefined, temperature: 0.2 }, settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {});
      const msg = json.choices?.[0]?.message as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } | undefined;
      if (!msg) throw new Error('The model gave no answer.');
      this.history.push(msg);
      if (!msg.tool_calls?.length) return { reply: (msg.content ?? '').trim(), steps };
      for (const c of msg.tool_calls) {
        let args: Json = {};
        try {
          args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          // a model that wrote broken JSON: call with nothing, the tool says what is missing
        }
        const s = await this.run(c.function.name, args, steps);
        this.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(forModel(s.result, s.error)) });
      }
    }
    return { reply: lastWords(steps), steps };
  }
}

/** If the model never wrapped up, the last tool's own words are the answer. */
function lastWords(steps: Step[]): string {
  const last = [...steps].reverse().find((s) => s.result);
  return last?.result ? textOf(last.result) : '';
}
