/*
 Centralized tool response formatter
 - Provides a consistent envelope for all tool outputs
 - Markdown helpers (escape, truncate, tables, lists)
 - Size limits and truncation flags
 - Error normalization
 - withFormatting() wrapper to adopt incrementally without major churn
*/

// Envelope type used by tools
export type ToolResponse<T = any> = {
  success: boolean;
  title?: string;
  markdown?: string; // human-friendly rendering
  data?: T; // raw machine-usable payload
  meta?: {
    type?: string;
    source?: string;
    count?: number;
    truncated?: boolean;
    [k: string]: any;
  };
  warnings?: string[];
  actions?: Array<{ label: string; command: string }>;
};

// Limits (tuned for IDE panes)
export const DEFAULT_LIMITS = {
  maxRows: 50,
  maxCols: 10,
  maxText: 200,
  maxMarkdownBytes: 50 * 1024, // 50KB
};

export function mdEscape(input: any): string {
  const s = String(input ?? "");
  // Escape pipes to keep markdown tables intact
  return s.replace(/\|/g, "\\|");
}

export function truncate(input: any, max = DEFAULT_LIMITS.maxText): string {
  const s = String(input ?? "");
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function toMarkdownList(items: any[], opts?: { maxItems?: number }) {
  if (!Array.isArray(items)) return "";
  const max = opts?.maxItems ?? DEFAULT_LIMITS.maxRows;
  const shown = items.slice(0, max).map((v) => `- ${truncate(v)}`).join("\n");
  const extra = items.length > max ? `\n… (${items.length - max} more)` : "";
  return shown + extra;
}

export function toMarkdownTable(rows: any[], opts?: { maxRows?: number; maxCols?: number; maxText?: number }) {
  if (!Array.isArray(rows) || rows.length === 0) return "_Empty_";
  const maxRows = opts?.maxRows ?? DEFAULT_LIMITS.maxRows;
  const maxCols = opts?.maxCols ?? DEFAULT_LIMITS.maxCols;
  const maxText = opts?.maxText ?? DEFAULT_LIMITS.maxText;

  // Normalize to array of objects
  const objs = rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  const allKeys = Array.from(new Set(objs.flatMap((o) => Object.keys(o)))).slice(0, maxCols);
  if (allKeys.length === 0) return "_Empty_";

  const header = `| ${allKeys.map((k) => mdEscape(k)).join(" | ")} |`;
  const sep = `| ${allKeys.map(() => "---").join(" | ")} |`;
  const body = objs.slice(0, maxRows).map((o) => {
    const cells = allKeys.map((k) => {
      const v = o[k];
      // Allow raw markdown via { __md }
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).__md === 'string') {
        return truncate((v as any).__md, maxText);
      }
      // Wikilinks should not have their pipe escaped
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^\[\[[\s\S]*\]\]$/.test(t)) {
          return truncate(t, maxText);
        }
      }
      // Pretty-print arrays
      if (Array.isArray(v)) {
        const parts = v.map((e) => String(e ?? ''));
        return mdEscape(truncate(parts.join(', '), maxText));
      }
      return mdEscape(truncate(v, maxText));
    });
    return `| ${cells.join(" | ")} |`;
  }).join("\n");

  const extraRows = rows.length > maxRows ? `\n… (${rows.length - maxRows} more rows)` : "";
  const extraCols = (Array.from(new Set(objs.flatMap((o) => Object.keys(o)))).length > maxCols)
    ? `\n… (columns truncated)` : "";

  return [header, sep, body].join("\n") + extraRows + extraCols;
}

export function makeResponse<T = any>(params: Partial<ToolResponse<T>> & { success: boolean }): ToolResponse<T> {
  const resp: ToolResponse<T> = {
    success: params.success,
    title: params.title,
    markdown: params.markdown,
    data: params.data,
    meta: params.meta,
    warnings: params.warnings,
    actions: params.actions,
  };

  // Enforce markdown size cap to avoid flooding panes
  if (resp.markdown) {
    const bytes = new TextEncoder().encode(resp.markdown).length;
    if (bytes > DEFAULT_LIMITS.maxMarkdownBytes) {
      // Rough truncation by characters; good enough for safety cap
      const approxCharLimit = DEFAULT_LIMITS.maxMarkdownBytes - 512;
      resp.markdown = resp.markdown.slice(0, approxCharLimit) + "\n\n… (truncated)";
      resp.meta = { ...(resp.meta || {}), truncated: true };
    }
  }
  return resp;
}

export function errorToResponse(e: any, context?: { title?: string }): ToolResponse {
  const msg = e?.message || String(e);
  const stack = e?.stack ? `\n\n\nDetails:\n\n\`\`\`\n${e.stack}\n\`\`\`` : "";
  return makeResponse({
    success: false,
    title: context?.title || 'Tool error',
    markdown: `❌ ${mdEscape(msg)}${stack}`,
    data: { error: msg },
    meta: { error: true },
  });
}

// Wrap an existing handler to enforce envelope + defaults
// handler: a function returning either a ToolResponse or raw data to be wrapped
export function withFormatting<TArgs = any, TData = any>(
  handler: (args: TArgs) => Promise<ToolResponse<TData> | TData>,
  opts?: { title?: string; render?: (data: TData) => string; type?: string }
) {
  return async (args: TArgs): Promise<ToolResponse<TData>> => {
    try {
      const result = await handler(args);
      if (result && typeof (result as any).success === 'boolean') {
        // Already a ToolResponse
        return result as ToolResponse<TData>;
      }
      const data = result as TData;
      const markdown = opts?.render ? opts.render(data) : undefined;
      return makeResponse<TData>({
        success: true,
        title: opts?.title,
        markdown,
        data,
        meta: { type: opts?.type },
      });
    } catch (e) {
      return errorToResponse(e, { title: opts?.title });
    }
  };
}
