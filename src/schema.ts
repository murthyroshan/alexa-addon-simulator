// A form for any tool, built from its JSON Schema: the arguments the assistant would fill in from
// speech, filled in by hand. Values come back as the types the schema asks for.

export type FieldKind = 'text' | 'longtext' | 'number' | 'integer' | 'boolean' | 'choice' | 'list' | 'json';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  initial: string;
}

type Prop = {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  anyOf?: Prop[];
  default?: unknown;
  items?: Prop;
  maxLength?: number;
};

const typeOf = (p: Prop): string | undefined => {
  if (Array.isArray(p.type)) return p.type.find((t) => t !== 'null');
  if (p.type) return p.type;
  // Optional fields often arrive as anyOf [X, null].
  const inner = p.anyOf?.find((a) => a.type && a.type !== 'null');
  return inner ? typeOf(inner) : undefined;
};

export function fieldsOf(schema: unknown): Field[] {
  const s = (schema ?? {}) as { properties?: Record<string, Prop>; required?: string[] };
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).map(([key, p]) => {
    const type = typeOf(p);
    const choices = p.enum ?? p.oneOf?.map((o) => o.const);
    const options = choices?.every((c) => typeof c === 'string' || typeof c === 'number')
      ? choices.map((c, i) => ({ value: String(c), label: p.oneOf?.[i]?.title ?? String(c) }))
      : undefined;
    let kind: FieldKind =
      options ? 'choice'
      : type === 'boolean' ? 'boolean'
      : type === 'integer' ? 'integer'
      : type === 'number' ? 'number'
      : type === 'array' && typeOf(p.items ?? {}) === 'string' ? 'list'
      : type === 'string' || type === undefined ? 'text'
      : 'json';
    if (kind === 'text' && (p.maxLength ?? 0) > 200) kind = 'longtext';
    const initial =
      p.default === undefined ? (kind === 'boolean' && required.has(key) ? 'false' : '')
      : kind === 'json' ? JSON.stringify(p.default)
      : kind === 'list' && Array.isArray(p.default) ? p.default.join('\n')
      : String(p.default);
    return { key, label: p.title ?? key, kind, required: required.has(key), description: p.description, options, initial };
  });
}

/** The tool's arguments from the form, or what is wrong with the form. Empty optional fields are left out. */
export function argsOf(fields: Field[], values: Record<string, string>): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? '').trim();
    if (!raw) {
      if (f.required) errors[f.key] = 'Required';
      continue;
    }
    switch (f.kind) {
      case 'number':
      case 'integer': {
        const n = Number(raw);
        if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) errors[f.key] = f.kind === 'integer' ? 'A whole number' : 'A number';
        else args[f.key] = n;
        break;
      }
      case 'boolean':
        args[f.key] = raw === 'true';
        break;
      case 'list':
        args[f.key] = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        break;
      case 'json':
        try {
          args[f.key] = JSON.parse(raw);
        } catch {
          errors[f.key] = 'Not valid JSON';
        }
        break;
      case 'choice': {
        // Choices keep their type: a number enum stays a number.
        const n = Number(raw);
        args[f.key] = f.options?.some((o) => o.value === raw) && raw !== '' && !Number.isNaN(n) && String(n) === raw && isNumericChoice(f) ? n : raw;
        break;
      }
      default:
        args[f.key] = values[f.key];
    }
  }
  return { args, errors };
}

const isNumericChoice = (f: Field) => Boolean(f.options?.length && f.options.every((o) => o.value !== '' && !Number.isNaN(Number(o.value))));
