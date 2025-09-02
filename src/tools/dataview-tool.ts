import { ObsidianAPI } from '../utils/obsidian-api';
import { PluginDetector } from '../utils/plugin-detector';
import {
  ToolResponse,
  makeResponse,
  errorToResponse,
  toMarkdownList,
  toMarkdownTable,
  mdEscape,
  DEFAULT_LIMITS,
} from './format';

/**
 * Dataview tool implementation for querying vault data
 */
export class DataviewTool {
  private detector: PluginDetector;

  constructor(private api: ObsidianAPI) {
    this.detector = new PluginDetector(api.getApp());
  }

  /**
   * Check if Dataview functionality is available
   */
  isAvailable(): boolean {
    return this.detector.isDataviewAPIReady();
  }

  /**
   * Get Dataview status information
   */
  getStatus() {
    return this.detector.getDataviewStatus();
  }

  /**
   * Execute a Dataview query
   */
  async executeQuery(query: string, format: 'dql' | 'js' = 'dql'): Promise<any> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = this.detector.getDataviewAPI();
    
    try {
      if (format === 'dql') {
        // Execute DQL query
        const result = await dataviewAPI.query(query);
        const normalized = this.formatQueryResult(result);
        const type = normalized?.type || result.type || 'unknown';

        // Build markdown rendering by type
        let markdown = '';
        let count: number | undefined = undefined;
        if (type === 'list') {
          const values = Array.isArray((normalized as any).values) ? (normalized as any).values : [];
          count = values.length;
          markdown = `### Results (List)\n` + toMarkdownList(values, { maxItems: DEFAULT_LIMITS.maxRows });
        } else if (type === 'table') {
          const headers: any[] = Array.isArray((normalized as any).headers) ? (normalized as any).headers : [];
          const toArray = (x: any): any[] => Array.isArray(x)
            ? x
            : (x && typeof x.array === 'function')
              ? x.array()
              : [];
          // Gather possible row containers from various shapes
          const candidates: any[] = [
            (normalized as any)?.values,
            (normalized as any)?.value?.values,
            (normalized as any)?.rows,
            (normalized as any)?.value?.rows,
          ].map(toArray).filter(arr => Array.isArray(arr));
          const rows: any[] = candidates.find(arr => arr.length > 0) || [];
          count = rows.length;
          const getByPath = (obj: any, path: string) => {
            const parts = String(path).split('.');
            let cur = obj;
            for (const p of parts) {
              if (cur == null) return undefined;
              cur = cur[p];
            }
            return cur;
          };

          const toPrintable = (v: any): any => {
            // Mirror behavior of cellToPrintable for object-row cells
            if (v == null) return v;
            if (v && typeof v === 'object' && 'value' in v && (v as any).value !== undefined) {
              return toPrintable((v as any).value);
            }
            if (v && typeof (v as any).toISOString === 'function') return (v as any).toISOString();
            // Handle Dataview file objects with path property
            if (v && typeof v === 'object' && (v as any).path && typeof (v as any).path === 'string') {
              const path = (v as any).path;
              const fileName = path.split('/').pop()?.replace(/\.md$/i, '') || path;
              return `[[${path}|${fileName}]]`;
            }
            // Handle other link-like objects
            if (v && typeof v === 'object' && ((v as any).path || (v as any).file)) {
              const path = (v as any).path ?? (v as any).file?.path;
              const display = (v as any).display ?? (v as any).name ?? (v as any).file?.name ?? path;
              if (path) return `[[${String(path)}|${String(display)}]]`;
            }
            return v;
          };

          // Handle transposed data: if we get arrays per column, expand them into rows
          let processedObjects: Record<string, any>[] = [];
          
          if (rows.length === 1) {
            // Check if this is transposed data (single "row" with arrays per column)
            const firstRow = rows[0];
            const columnValues: Record<string, any[]> = {};
            let maxLength = 0;
            let hasArrays = false;
            
            headers.forEach((header: any, index: number) => {
              const headerStr = String(header);
              let value: any;
              
              // Extract value from row
              if (Array.isArray(firstRow)) {
                value = firstRow[index];
              } else if (firstRow && typeof firstRow.array === 'function') {
                const arr = firstRow.array();
                value = arr[index];
              } else {
                value = getByPath(firstRow, headerStr);
              }
              
              // If value is an array, this is transposed data
              if (Array.isArray(value)) {
                columnValues[headerStr] = value;
                maxLength = Math.max(maxLength, value.length);
                hasArrays = true;
              } else {
                columnValues[headerStr] = [value];
                maxLength = Math.max(maxLength, 1);
              }
            });
            
            if (hasArrays) {
              // Expand transposed arrays into separate row objects
              for (let rowIndex = 0; rowIndex < maxLength; rowIndex++) {
                const obj: Record<string, any> = {};
                headers.forEach((header: any) => {
                  const headerStr = String(header);
                  const columnArray = columnValues[headerStr];
                  const rawValue = columnArray[rowIndex];
                  obj[headerStr] = normalizeTableCell(rawValue, headerStr);
                });
                processedObjects.push(obj);
              }
            } else {
              // Single row, process normally
              const obj: Record<string, any> = {};
              headers.forEach((header: any) => {
                const headerStr = String(header);
                const rawValue = columnValues[headerStr][0];
                obj[headerStr] = normalizeTableCell(rawValue, headerStr);
              });
              processedObjects.push(obj);
            }
          } else {
            // Multiple rows, process each normally
            processedObjects = rows.map((row: any) => {
              const obj: Record<string, any> = {};
              
              headers.forEach((header: any, index: number) => {
                const headerStr = String(header);
                let value: any;
                
                // Extract value from row
                if (Array.isArray(row)) {
                  value = row[index];
                } else if (row && typeof row.array === 'function') {
                  const arr = row.array();
                  value = arr[index];
                } else {
                  value = getByPath(row, headerStr);
                }
                
                // Normalize the value based on what we expect for this column
                obj[headerStr] = normalizeTableCell(value, headerStr);
              });
              
              return obj;
            });
          }
          
          // Helper function to normalize cell values
          function normalizeTableCell(value: any, columnName: string): any {
            // Handle null/undefined
            if (value == null) return value;
            
            // Handle date/function columns - if we get a file object for a date column, it's misaligned data
            if (columnName.includes('date(') || columnName.includes('today')) {
              // If we got a file object for a date column, return the current date as fallback
              if (value && typeof value === 'object' && (value as any).path) {
                return new Date().toISOString();
              }
              // Handle actual date objects
              if (value && typeof value.toISOString === 'function') {
                return value.toISOString();
              }
              // Handle date strings
              if (typeof value === 'string' && value.includes('T')) {
                return value;
              }
              // Fallback for date columns
              return new Date().toISOString();
            }
            
            // Handle Dataview file objects
            if (value && typeof value === 'object' && (value as any).path) {
              const path = (value as any).path;
              const fileName = path.split('/').pop()?.replace(/\.md$/i, '') || path;
              
              switch (columnName) {
                case 'File':
                case 'file.link':
                  return `[[${path}|${fileName}]]`;
                case 'file.name':
                  return fileName;
                case 'file.path':
                  return path;
                case 'file.tags':
                  return []; // Tags should be arrays, not file objects
                default:
                  return `[[${path}|${fileName}]]`;
              }
            }
            
            // Handle dates
            if (value && typeof value.toISOString === 'function') {
              return value.toISOString();
            }
            
            // Handle arrays
            if (Array.isArray(value)) {
              if (value.length === 1) return value[0];
              return value;
            }
            
            // Handle wrapped values
            if (value && typeof value === 'object' && 'value' in value) {
              return normalizeTableCell((value as any).value, columnName);
            }
            
            return value;
          }

          let tableMd = toMarkdownTable(processedObjects, { maxRows: DEFAULT_LIMITS.maxRows, maxCols: DEFAULT_LIMITS.maxCols, maxText: DEFAULT_LIMITS.maxText });
          // Debug: always show first object structure when we have data
          if (rows.length && headers.length && processedObjects.length) {
            const firstObj = processedObjects[0] || {};
            const objPreview = JSON.stringify(firstObj, null, 2).slice(0, 800);
            tableMd += `\n\n<details><summary>Debug: first processed object</summary>\n\n\`\`\`json\n${objPreview}\n\`\`\`\n</details>`;
            
            const emptyCells = headers.every(h => {
              const v = firstObj[String(h)];
              return v == null || v === '';
            });
            if (emptyCells) {
              try {
                const raw = rows[0];
                const preview = typeof raw === 'object' ? JSON.stringify(raw, (k, v) => {
                  if (typeof v === 'function') return `[function]`;
                  if (v && typeof v === 'object' && Object.keys(v).length > 20) return `[object:${Object.keys(v).length} keys]`;
                  return v;
                }, 2) : String(raw);
                tableMd += `\n\n<details><summary>Debug: first row shape</summary>\n\n\n\n\`\`\`json\n${preview.slice(0, 1200)}\n\`\`\`\n</details>`;
                const dbg = (normalized as any)?.debug;
                if (dbg) {
                  const dbgPreview = JSON.stringify(dbg, null, 2).slice(0, 1200);
                  tableMd += `\n\n<details><summary>Debug: normalization info</summary>\n\n\n\n\`\`\`json\n${dbgPreview}\n\`\`\`\n</details>`;
                }
                // NEW: raw result shape probe (only when empty cells)
                const probeLen = (x: any): number | undefined => {
                  try {
                    if (!x) return undefined;
                    if (Array.isArray(x)) return x.length;
                    if (typeof x.array === 'function') return x.array().length;
                    return undefined;
                  } catch { return undefined; }
                };
                const typeOf = (x: any) => Array.isArray(x) ? 'array' : typeof x;
                const containerCandidates: any[] = [result, result?.value, result?.values, result?.rows, result?.data];
                const candidateSummaries = containerCandidates.slice(0, 3).map((c, idx) => {
                  try {
                    const first = (() => {
                      if (!c) return undefined;
                      if (Array.isArray(c)) return c[0];
                      if (typeof c?.array === 'function') return c.array()[0];
                      return undefined;
                    })();
                    return {
                      idx,
                      type: typeOf(c),
                      hasHeaders: !!(c && (c as any).headers),
                      hasValues: !!(c && (c as any).values),
                      hasRows: !!(c && (c as any).rows),
                      length: probeLen(c),
                      firstType: typeOf(first),
                      firstHasValues: !!(first && (first as any).values),
                      firstHasCells: !!(first && (first as any).cells),
                      firstHasRow: !!(first && (first as any).row)
                    };
                  } catch { return { idx, error: true }; }
                });
                const topShape = {
                  resultType: String((result as any)?.type ?? 'unknown'),
                  hasHeaders: !!(result as any)?.headers,
                  topKeys: (() => { try { return Object.keys(result || {}).slice(0, 20); } catch { return []; } })(),
                  valueType: typeOf((result as any)?.value),
                  valuesType: typeOf((result as any)?.values),
                  rowsType: typeOf((result as any)?.rows),
                  dataType: typeOf((result as any)?.data),
                  valueLen: probeLen((result as any)?.value),
                  valuesLen: probeLen((result as any)?.values),
                  rowsLen: probeLen((result as any)?.rows),
                  dataLen: probeLen((result as any)?.data),
                  candidates: candidateSummaries
                };
                const topPreview = JSON.stringify(topShape, null, 2).slice(0, 1200);
                tableMd += `\n\n<details><summary>Debug: raw result shape</summary>\n\n\n\n\`\`\`json\n${topPreview}\n\`\`\`\n</details>`;
              } catch {}
            }
          }
          markdown = `### Results (Table)\n` + tableMd;
        } else if (type === 'task') {
          const tasks: any[] = Array.isArray((normalized as any).values) ? (normalized as any).values : [];
          count = tasks.length;
          const items = tasks.map(t => `[${t.completed ? 'x' : ' '}] ${mdEscape(t.text)}${t.path ? ` (${t.path}${typeof t.line === 'number' ? ':' + t.line : ''})` : ''}`);
          markdown = `### Results (Tasks)\n` + toMarkdownList(items, { maxItems: DEFAULT_LIMITS.maxRows });
        } else if (type === 'calendar') {
          markdown = `Calendar data returned.`;
        } else {
          markdown = `Unrecognized result type.`;
        }

        const data = {
          query,
          format,
          result: normalized,
          workflow: this.generateQueryWorkflow(query, result),
          hints: this.generateQueryHints(query, result),
        };

        const base = makeResponse({
          success: true,
          title: 'Dataview Query',
          markdown,
          data,
          meta: { type, source: 'dataview', count },
          warnings: result?.successful === false ? ['Query executed with warnings'] : undefined,
        });
        return {
          ...base,
          // Legacy top-level fields for backward compatibility
          query,
          format,
          result: normalized,
          type,
          workflow: data.workflow,
          hints: data.hints,
        };
      } else {
        // Execute JavaScript query (if needed in the future)
        throw new Error('JavaScript queries not yet implemented');
      }
    } catch (error) {
      return errorToResponse(error, { title: 'Dataview Query' });
    }
  }

  /**
   * List all pages with metadata
   */
  async listPages(source?: string): Promise<any> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = this.detector.getDataviewAPI();
    
    try {
      // Get pages from source (folder, tag, etc.) or all pages
      const pages = source 
        ? dataviewAPI.pages(source)
        : dataviewAPI.pages();
      const all = pages.array();
      const limited = all.slice(0, DEFAULT_LIMITS.maxRows).map((page: any) => ({
        path: page.file.path,
        name: page.file.name,
        size: page.file.size,
        created: page.file.ctime?.toISOString(),
        modified: page.file.mtime?.toISOString(),
        tags: page.file.tags?.array() || [],
        links: page.file.outlinks?.array()?.length || 0,
        aliases: page.aliases?.array() || [],
        // Include custom frontmatter fields
        ...this.extractCustomFields(page)
      }));

      const markdown = toMarkdownTable(limited, { maxRows: DEFAULT_LIMITS.maxRows, maxCols: DEFAULT_LIMITS.maxCols, maxText: DEFAULT_LIMITS.maxText });

      const base = makeResponse({
        success: true,
        title: 'Dataview Pages',
        markdown,
        data: { source: source || 'all', count: all.length, pages: limited },
        meta: { type: 'pages', source: source || 'all', count: all.length, truncated: all.length > limited.length },
      });
      return {
        ...base,
        // Legacy fields
        source: source || 'all',
        count: all.length,
        pages: limited,
      };
    } catch (error) {
      return errorToResponse(error, { title: 'Dataview Pages' });
    }
  }

  /**
   * Get metadata for a specific page
   */
  async getPageMetadata(path: string): Promise<any> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = this.detector.getDataviewAPI();
    
    try {
      const page = dataviewAPI.page(path);
      
      if (!page) {
        throw new Error(`Page not found: ${path}`);
      }
      const metadata = {
        file: {
          path: page.file.path,
          name: page.file.name,
          basename: page.file.basename,
          extension: page.file.extension,
          size: page.file.size,
          created: page.file.ctime?.toISOString(),
          modified: page.file.mtime?.toISOString()
        },
        tags: page.file.tags?.array() || [],
        aliases: page.aliases?.array() || [],
        outlinks: page.file.outlinks?.array() || [],
        inlinks: page.file.inlinks?.array() || [],
        tasks: page.file.tasks?.array()?.length || 0,
        lists: page.file.lists?.array()?.length || 0,
        // Include all custom frontmatter fields
        custom: this.extractCustomFields(page)
      };

      const markdown = [
        `### ${mdEscape(metadata.file.name)} Metadata`,
        `- Path: ${mdEscape(metadata.file.path)}`,
        `- Size: ${String(metadata.file.size)}`,
        `- Created: ${mdEscape(metadata.file.created || '')}`,
        `- Modified: ${mdEscape(metadata.file.modified || '')}`,
        `- Tags: ${mdEscape((metadata.tags || []).join(', '))}`,
        `- Aliases: ${mdEscape((metadata.aliases || []).join(', '))}`,
      ].join('\n');

      const base = makeResponse({
        success: true,
        title: 'Dataview Page Metadata',
        markdown,
        data: { path, metadata },
        meta: { type: 'metadata', source: 'dataview', path },
      });
      return {
        ...base,
        // Legacy fields
        path,
        metadata,
      };
    } catch (error) {
      return errorToResponse(error, { title: 'Dataview Page Metadata' });
    }
  }

  /**
   * Validate a DQL query syntax
   */
  async validateQuery(query: string): Promise<any> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    try {
      // Basic query structure validation
      const trimmedQuery = query.trim();
      const queryTypes = ['LIST', 'TABLE', 'TASK', 'CALENDAR'];
      const firstWord = trimmedQuery.split(/\s+/)[0]?.toUpperCase();

      if (!queryTypes.includes(firstWord)) {
        const msg = `Query must start with one of: ${queryTypes.join(', ')}`;
        const base = makeResponse({
          success: true,
          title: 'Validate DQL',
          markdown: `❌ ${mdEscape(msg)}`,
          data: { valid: false, query, error: msg },
          meta: { type: 'validation', source: 'dataview' },
        });
        return { ...base, valid: false, query, error: msg };
      }

      const base = makeResponse({
        success: true,
        title: 'Validate DQL',
        markdown: `✅ Query syntax appears valid (type: ${firstWord})`,
        data: { valid: true, query, queryType: firstWord, message: 'Query syntax appears valid' },
        meta: { type: 'validation', source: 'dataview', queryType: firstWord },
      });
      return { ...base, valid: true, query, queryType: firstWord };
    } catch (error) {
      return errorToResponse(error, { title: 'Validate DQL' });
    }
  }

  /**
   * Format query result for MCP response
   */
  private formatQueryResult(result: any): any {
    if (!result) return null;

    // Helper to coerce Dataview DataArray or plain arrays into JS arrays
    const toArray = (v: any): any[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v.array === 'function') return v.array();
      return [v];
    };

    // Infer a more accurate type if missing or unexpected
    const inferType = (r: any): string => {
      if (r.type) return String(r.type).toLowerCase();
      const candidate = (r.values ?? r.value ?? r.rows ?? r.tasks ?? r.data);
      // If the nested candidate looks like a table container, treat as table
      if (candidate && typeof candidate === 'object' && (candidate.headers) && (candidate.values || candidate.rows)) {
        return 'table';
      }
      const vals = toArray(candidate);
      if (r.headers && (r.values || r.rows)) return 'table';
      if (vals.length) {
        if (Array.isArray(vals[0])) return 'table';
        const t0 = vals[0];
        if (t0 && typeof t0 === 'object') {
          const isTaskLike = (
            'task' in t0 ||
            'checked' in t0 ||
            'completed' in t0 ||
            'status' in t0 ||
            'text' in t0
          );
          if (isTaskLike) return 'task';
          return 'list';
        }
        return 'list';
      }
      return 'unknown';
    };

    let type = inferType(result);
    let valuesSource: any = (result.values ?? result.value ?? result.rows ?? result.tasks ?? result.data);
    // Capture possible headers if present in a nested value container
    let headersHint: any[] | undefined = undefined;

    // Unwrap a nested container like [{ type: 'task', values: [...] }] or { type, values }
    const tryUnwrap = (v: any): any | null => {
      if (Array.isArray(v) && v.length === 1) {
        const el = v[0];
        if (el && typeof el === 'object' && (el.type) && (el.values || el.rows || el.tasks || el.data)) {
          return el;
        }
      }
    if (v && typeof v === 'object' && (v.type) && (v.values || v.rows || v.tasks || v.data)) {
        return v;
      }
      return null;
    };

    const unwrapped = tryUnwrap(valuesSource);
    if (unwrapped) {
      type = inferType(unwrapped);
      headersHint = Array.isArray(unwrapped.headers) ? unwrapped.headers : (unwrapped.headers?.array?.() ?? undefined);
      valuesSource = (unwrapped.values ?? unwrapped.rows ?? unwrapped.tasks ?? unwrapped.data);
    }

    switch (type) {
      case 'list': {
        return {
          type: 'list',
          values: toArray(valuesSource)
        };
      }
      case 'table': {
        // If the top-level didn't unwrap, valuesSource may still be the table container (e.g., result.value)
        // Detect and extract rows/headers from nested container if needed
        let rowsCandidate: any = valuesSource;
        const safeInvoke = (fn: any, thisArg?: any) => {
          try {
            if (typeof fn !== 'function') return fn;
            // Try direct call
            const v1 = thisArg ? fn.call(thisArg) : fn();
            if (v1 !== undefined) return v1;
          } catch {}
          try {
            // Try call with undefined this
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const v2 = fn.call(undefined);
            if (v2 !== undefined) return v2;
          } catch {}
          try {
            // Try apply with empty args
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const v3 = fn.apply(thisArg ?? undefined, []);
            if (v3 !== undefined) return v3;
          } catch {}
          return fn; // could be a function-object with properties (e.g., get, Symbol.iterator)
        };
        // Some Dataview internals expose row containers as thunks (functions). Invoke if so.
        rowsCandidate = safeInvoke(rowsCandidate);
        // If container remains a function but is iterable, materialize it
        try {
          if (typeof rowsCandidate === 'function' && (rowsCandidate as any)[Symbol.iterator]) {
            rowsCandidate = Array.from(rowsCandidate as any);
          }
        } catch {}
        let headersCandidate: any = headersHint;
        let rowsThisArg: any = undefined;
        // If rowsCandidate is a table-like container (has .values or .rows), extract from it
        if (
          (rowsCandidate && (typeof rowsCandidate === 'object' || typeof rowsCandidate === 'function') && ((rowsCandidate as any).values || (rowsCandidate as any).rows))
        ) {
          // Normalize guard precedence
          if (
            rowsCandidate && (typeof rowsCandidate === 'object' || typeof rowsCandidate === 'function') && (((rowsCandidate as any).values) || ((rowsCandidate as any).rows))
          ) {
            const container = rowsCandidate;
            rowsThisArg = container;
            headersCandidate = headersCandidate ?? (
              Array.isArray((container as any).headers)
                ? (container as any).headers
                : ((container as any).headers?.array?.() ?? undefined)
            );
            let inner = ((container as any).values ?? (container as any).rows);
            // The nested rows can also be a thunk; invoke with container bound as this
            inner = safeInvoke(inner, container);
            // Or an iterable function-object
            try {
              if (typeof inner === 'function' && (inner as any)[Symbol.iterator]) {
                inner = Array.from(inner as any);
              }
            } catch {}
            rowsCandidate = inner;
          }
        }
        const cellToPrintable = (v: any): any => {
          if (v == null) return v;
          // Unwrap DV wrapper shapes
          if (v && typeof v === 'object' && 'value' in v && v.value !== undefined) {
            return cellToPrintable(v.value);
          }
          // Dates
          if (v && typeof v.toISOString === 'function') return v.toISOString();
          // Links
          if (v && typeof v === 'object' && ('path' in v || v.file)) {
            const path = (v as any).path ?? (v as any).file?.path;
            const display = (v as any).display ?? (v as any).name ?? (v as any).file?.name ?? path;
            if (path) return `[[${String(path)}|${String(display)}]]`;
          }
          return v;
        };
        const rawRowsArr = toArray(rowsCandidate).map((r: any) => {
          if (typeof r === 'function') {
            const v = safeInvoke(r, rowsThisArg);
            if (v !== r) return v;
            // If still a function but iterable, expand to array of cells
            try {
              if ((r as any)[Symbol.iterator]) {
                return { __cells: Array.from(r as any), __ctx: r };
              }
            } catch {}
          }
          // If row is an object that is iterable, expand to an array
          try {
            if (r && typeof r === 'object' && (r as any)[Symbol.iterator]) {
              return { __cells: Array.from(r as any), __ctx: r };
            }
          } catch {}
          return r;
        });
        // Debug: show raw rows structure before processing
        if (rawRowsArr.length) {
          console.log('[DEBUG] Raw rows count:', rawRowsArr.length);
          console.log('[DEBUG] First raw row:', JSON.stringify(rawRowsArr[0], (k, v) => typeof v === 'function' ? '[function]' : v, 2).slice(0, 500));
        }
        
        const rows = rawRowsArr.map((row: any) => {
          const originalRow = (row && row.__ctx) ? row.__ctx : row;
          const invokeCell = (fn: any, colIndex: number): any => {
            const ctxs = [rowsThisArg, originalRow, (row && row.__ctx), undefined];
            // Try no-arg across contexts
            for (const ctx of ctxs) {
              try {
                const v = typeof fn === 'function' ? fn.call(ctx) : fn;
                if (v !== undefined && typeof v !== 'function') return v;
              } catch {}
            }
            // Try with column index across contexts
            for (const ctx of ctxs) {
              try {
                if (typeof fn === 'function') {
                  const v = fn.call(ctx, colIndex);
                  if (v !== undefined && typeof v !== 'function') return v;
                }
              } catch {}
            }
            // If still function, attempt iterable expansion
            try {
              if (fn && typeof fn === 'function' && (fn as any)[Symbol.iterator]) {
                return Array.from(fn as any);
              }
            } catch {}
            return fn; // fallback
          };
          // Dataview Row objects often have a .values DataArray
          if (row?.values) {
            const arr = Array.isArray(row.values) ? row.values : (typeof row.values.array === 'function' ? row.values.array() : [row.values]);
            let cells = arr.map(cellToPrintable);
            if (cells.length === 1 && Array.isArray(cells[0])) cells = cells[0];
            if (Array.isArray(headersCandidate) && cells.length > headersCandidate.length) cells = cells.slice(0, headersCandidate.length);
            // Synthesize implicit 'File' column if headers expect it
            if (headersCandidate && headersCandidate[0] === 'File' && headersCandidate.length === cells.length + 1) {
              const filePath = originalRow?.file?.path ?? originalRow?.path ?? originalRow?.filePath;
              const fileName = originalRow?.file?.name ?? originalRow?.name ?? originalRow?.fileName ?? filePath;
              const link = filePath ? `[[${String(filePath)}|${String(fileName)}]]` : '';
              cells = [link, ...cells];
            }
            return cells;
          }
          // Some shapes expose cells under different keys
          if (row?.cells) {
            const arr = Array.isArray(row.cells) ? row.cells : (typeof row.cells.array === 'function' ? row.cells.array() : [row.cells]);
            return arr.map(cellToPrintable);
          }
          if (row?.row) {
            const arr = Array.isArray(row.row) ? row.row : (typeof row.row.array === 'function' ? row.row.array() : [row.row]);
            let cells = arr.map(cellToPrintable);
            if (cells.length === 1 && Array.isArray(cells[0])) cells = cells[0];
            if (Array.isArray(headersCandidate) && cells.length > headersCandidate.length) cells = cells.slice(0, headersCandidate.length);
            return cells;
          }
          if (row?.value && Array.isArray(row.value)) {
            let cells = row.value.map(cellToPrintable);
            if (cells.length === 1 && Array.isArray(cells[0])) cells = cells[0];
            if (Array.isArray(headersCandidate) && cells.length > headersCandidate.length) cells = cells.slice(0, headersCandidate.length);
            return cells;
          }
          // Wrapped iterable { __cells, __ctx }
          if (row && Array.isArray(row.__cells)) {
            let cells = row.__cells.map((c: any, i: number) => cellToPrintable(typeof c === 'function' ? invokeCell(c, i) : c));
            // Flatten if a single nested array is present
            if (cells.length === 1 && Array.isArray(cells[0])) {
              cells = cells[0];
            }
            // If more cells than headers, trim to headers length
            if (Array.isArray(headersCandidate) && cells.length > headersCandidate.length) {
              cells = cells.slice(0, headersCandidate.length);
            }
            if (headersCandidate && headersCandidate[0] === 'File' && headersCandidate.length === cells.length + 1) {
              const filePath = row.__ctx?.file?.path ?? row.__ctx?.path ?? row.__ctx?.filePath;
              const fileName = row.__ctx?.file?.name ?? row.__ctx?.name ?? row.__ctx?.fileName ?? filePath;
              const link = filePath ? `[[${String(filePath)}|${String(fileName)}]]` : '';
              cells = [link, ...cells];
            }
            return cells;
          }
          // Dataview DataArray-like row with get(i) (row may be an object or a function-object)
          if (row && typeof (row as any).get === 'function' && Array.isArray(headersCandidate)) {
            try {
              const cells = headersCandidate.map((_: any, i: number) => cellToPrintable((row as any).get(i)));
              return cells;
            } catch {}
          }
          // Function rows: attempt to read numeric enumerable properties as cells
          if (typeof row === 'function') {
            try {
              const keys = Object.keys(row).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
              if (keys.length) {
                return keys.map(k => {
                  const v = (row as any)[k];
                  const invoked = typeof v === 'function' ? safeInvoke(v, row) : v;
                  return cellToPrintable(invoked);
                });
              }
            } catch {}
          }
          // Function-object iterable row already expanded to array above; handle any array
          if (Array.isArray(row)) {
            let cells = row.map((c: any, i: number) => cellToPrintable(typeof c === 'function' ? invokeCell(c, i) : c));
            if (cells.length === 1 && Array.isArray(cells[0])) {
              cells = cells[0];
            }
            if (Array.isArray(headersCandidate) && cells.length > headersCandidate.length) {
              cells = cells.slice(0, headersCandidate.length);
            }
            return cells;
          }
          if (row && typeof row.array === 'function') return row.array().map(cellToPrintable);
          // Fallback: convert object row values to array in header order if available
          if (headersCandidate && Array.isArray(headersCandidate) && row && typeof row === 'object') {
            const getByPath = (obj: any, path: string) => {
              const parts = String(path).split('.');
              let cur = obj;
              for (const p of parts) {
                if (cur == null) return undefined;
                cur = cur[p];
              }
              return cur;
            };
            let cells = headersCandidate.map((h: any) => cellToPrintable(getByPath(row, String(h))));
            if (headersCandidate[0] === 'File' && headersCandidate.length === cells.length + 1) {
              const filePath = (row as any)?.file?.path ?? (row as any)?.path ?? (row as any)?.filePath;
              const fileName = (row as any)?.file?.name ?? (row as any)?.name ?? (row as any)?.fileName ?? filePath;
              const link = filePath ? `[[${String(filePath)}|${mdEscape(String(fileName))}]]` : '';
              cells = [link, ...cells];
            }
            if (cells.every((c: any) => c === undefined || c === '')) {
              const numericKeys = Object.keys(row).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
              if (numericKeys.length) {
                cells = numericKeys.map(k => cellToPrintable((row as any)[k]));
              }
            }
            return cells;
          }
          return Object.values(row ?? {}).map(cellToPrintable);
        });
        // Prepare debug info about the raw first row before conversion
        let debug: any = undefined;
        if (rawRowsArr.length) {
          try {
            const r0 = rawRowsArr[0];
            debug = {
              rawFirstRowType: Array.isArray(r0) ? 'array' : typeof r0,
              rawFirstRowKeys: r0 && typeof r0 === 'object' ? Object.keys(r0).slice(0, 20) : undefined,
              hasValues: !!(r0 && (r0 as any).values),
              hasCells: !!(r0 && (r0 as any).cells),
              hasRow: !!(r0 && (r0 as any).row),
              hasArrayFn: !!(r0 && typeof (r0 as any).array === 'function'),
              hasGet: !!(r0 && typeof (r0 as any).get === 'function'),
              rowFnArity: typeof r0 === 'function' ? (r0 as any).length : undefined,
              hasIterator: !!(r0 && (r0 as any)[Symbol.iterator]),
              ownKeysCount: (() => { try { return r0 ? Object.keys(r0).length : 0; } catch { return -1; } })(),
              numericKeysCount: (() => { try { return r0 ? Object.keys(r0).filter(k => /^\d+$/.test(k)).length : 0; } catch { return -1; } })()
            };
          } catch {}
        }
        return {
          type: 'table',
          headers: (
            (Array.isArray(result.headers) ? result.headers : (result.headers?.array?.() ?? undefined))
            ?? headersCandidate
            ?? []
          ),
          values: rows,
          debug
        };
      }
      case 'task': {
        const tasks = toArray(valuesSource).map((task: any) => {
          const text = task?.text ?? task?.description ?? '';
          const completed = (
            task?.completed ??
            task?.checked ??
            (typeof task?.status === 'string' && ['x', 'X', 'done', 'completed', 'true'].includes(task.status))
          ) ? true : false;
          const line = task?.line ?? task?.position?.start?.line ?? undefined;
          const path = task?.path ?? task?.file?.path ?? task?.section?.path ?? task?.header?.path ?? undefined;
          return { text, completed, line, path };
        });
        return {
          type: 'task',
          values: tasks
        };
      }
      case 'calendar': {
        return {
          type: 'calendar',
          values: result.values || {}
        };
      }
      default: {
        return {
          type: 'unknown',
          data: result
        };
      }
    }
  }

  /**
   * Extract custom frontmatter fields from a page
   */
  private extractCustomFields(page: any): Record<string, any> {
    const customFields: Record<string, any> = {};
    
    // Standard fields to exclude
    const excludeFields = new Set([
      'file', 'tags', 'aliases', 'outlinks', 'inlinks', 'tasks', 'lists'
    ]);

    // Extract all non-standard fields
    for (const [key, value] of Object.entries(page)) {
      if (!excludeFields.has(key) && !key.startsWith('$')) {
        // Convert Dataview values to plain JavaScript values
        customFields[key] = this.convertDataviewValue(value);
      }
    }

    return customFields;
  }

  /**
   * Convert Dataview values to plain JavaScript values
   */
  private convertDataviewValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle Dataview arrays
    if (value && typeof value.array === 'function') {
      return value.array().map((item: any) => this.convertDataviewValue(item));
    }

    // Handle Dataview dates
    if (value && value.toISOString && typeof value.toISOString === 'function') {
      return value.toISOString();
    }

    // Handle Dataview links
    if (value && value.path && value.display) {
      return {
        path: value.path,
        display: value.display
      };
    }

    return value;
  }

  /**
   * Generate workflow suggestions for query results
   */
  private generateQueryWorkflow(query: string, result: any): any {
    const queryType = query.trim().split(/\s+/)[0]?.toUpperCase();
    const suggestions: any[] = [];

    // Base suggestions for all query types
    suggestions.push({
      description: 'View Dataview query reference',
      command: 'system(action="fetch_resource", uri="obsidian://dataview-reference")',
      reason: 'Learn more DQL syntax and examples'
    });

    switch (queryType) {
      case 'LIST':
        suggestions.push({
          description: 'Convert to TABLE for more details',
          command: `dataview(action="query", query="${query.replace('LIST', 'TABLE file.size, file.mtime')}")`,
          reason: 'See file metadata alongside results'
        });
        break;
      case 'TABLE':
        suggestions.push({
          description: 'Filter results with WHERE clause',
          command: `dataview(action="query", query="${query} WHERE file.size > 1000")`,
          reason: 'Narrow down results based on criteria'
        });
        break;
      case 'TASK':
        suggestions.push({
          description: 'Show only incomplete tasks',
          command: `dataview(action="query", query="${query} WHERE !completed")`,
          reason: 'Focus on pending tasks'
        });
        break;
    }

    // Add sorting suggestion if not already present
    if (!query.toLowerCase().includes('sort')) {
      suggestions.push({
        description: 'Sort results by modification date',
        command: `dataview(action="query", query="${query} SORT file.mtime DESC")`,
        reason: 'Show most recently modified files first'
      });
    }

    return {
      message: `${queryType} query executed successfully${result.successful ? '' : ' with warnings'}`,
      suggested_next: suggestions.slice(0, 3) // Limit to 3 suggestions
    };
  }

  /**
   * Generate query optimization hints
   */
  private generateQueryHints(query: string, result: any): any {
    const hints: string[] = [];
    const queryLower = query.toLowerCase();

    // Performance hints
    if (!queryLower.includes('limit') && !queryLower.includes('where')) {
      hints.push('Consider adding LIMIT clause for large vaults to improve performance');
    }

    if (queryLower.includes('from ""') || queryLower.includes('from "."')) {
      hints.push('Querying all files can be slow - consider filtering by folder or tag');
    }

    // Syntax hints
    if (queryLower.includes('where') && !queryLower.includes('sort')) {
      hints.push('Add SORT clause to order filtered results (e.g., SORT file.mtime DESC)');
    }

    if (queryLower.includes('table') && !queryLower.includes('as ')) {
      hints.push('Use AS keyword to rename columns (e.g., file.size AS "Size (bytes)")');
    }

    // Data type hints
    if (queryLower.includes('rating') || queryLower.includes('priority')) {
      hints.push('Custom frontmatter fields like rating/priority need to be defined in your notes');
    }

    return {
      performance: hints.filter(h => h.includes('performance') || h.includes('slow')),
      syntax: hints.filter(h => h.includes('SORT') || h.includes('AS') || h.includes('LIMIT')),
      data: hints.filter(h => h.includes('frontmatter') || h.includes('defined')),
      alternatives: this.generateAlternativeQueries(query)
    };
  }

  /**
   * Generate alternative query suggestions
   */
  private generateAlternativeQueries(query: string): string[] {
    const alternatives: string[] = [];
    const queryType = query.trim().split(/\s+/)[0]?.toUpperCase();

    switch (queryType) {
      case 'LIST':
        alternatives.push(query.replace('LIST', 'TABLE file.size, file.mtime'));
        alternatives.push(query.replace('LIST', 'CALENDAR file.ctime'));
        break;
      case 'TABLE':
        alternatives.push(query.replace(/TABLE.*FROM/, 'LIST FROM'));
        if (!query.toLowerCase().includes('group by')) {
          alternatives.push(query + ' GROUP BY file.folder');
        }
        break;
      case 'TASK':
        alternatives.push(query.replace('TASK', 'LIST'));
        break;
    }

    return alternatives.slice(0, 2); // Limit alternatives
  }

  /**
   * Generate Dataview reference content for MCP resource
   */
  static generateDataviewReference(): string {
    return `# Dataview Query Language (DQL) Reference

## Query Types

### LIST
Lists files matching criteria
\`\`\`
LIST FROM "folder"
LIST FROM #tag
LIST FROM [[Note]] AND #tag
LIST FROM "folder" WHERE rating > 3
LIST FROM #project WHERE status = "active" SORT file.mtime DESC
\`\`\`

### TABLE
Displays data in tabular format
\`\`\`
TABLE file.size, file.mtime FROM "Notes"
TABLE rating, status, file.name FROM #project
TABLE author, published AS "Year" FROM #books WHERE rating >= 4
TABLE length(file.outlinks) AS "Links" FROM "Research"
\`\`\`

### TASK
Shows tasks from notes
\`\`\`
TASK FROM "Projects"
TASK FROM #todo WHERE !completed
TASK FROM "Daily Notes" WHERE contains(text, "urgent")
\`\`\`

### CALENDAR
Calendar view of dates
\`\`\`
CALENDAR file.ctime FROM "Daily Notes"
CALENDAR created FROM #meeting
CALENDAR due FROM #project WHERE !completed
\`\`\`

## Common Fields

### File Fields
- \`file.path\` - Full file path
- \`file.name\` - File name with extension
- \`file.basename\` - File name without extension
- \`file.size\` - File size in bytes
- \`file.ctime\` - Creation time
- \`file.mtime\` - Modification time
- \`file.folder\` - Parent folder
- \`file.outlinks\` - Outgoing links
- \`file.inlinks\` - Incoming links
- \`file.tags\` - File tags

### Custom Fields
Any frontmatter field can be used:
- \`rating\` - Custom rating field
- \`status\` - Project status
- \`author\` - Book author
- \`priority\` - Task priority
- \`due\` - Due date

## Operators

### Comparison
- \`=\` - Equal
- \`!=\` - Not equal
- \`>\`, \`>=\` - Greater than (or equal)
- \`<\`, \`<=\` - Less than (or equal)

### Logical
- \`AND\` - Both conditions true
- \`OR\` - Either condition true
- \`!\` - Not (negation)

### Text
- \`contains(field, "text")\` - Contains text
- \`startswith(field, "prefix")\` - Starts with
- \`endswith(field, "suffix")\` - Ends with
- \`regexmatch(field, "pattern")\` - Regex match

## Functions

### Date Functions
- \`date(today)\` - Today's date
- \`date("2024-01-01")\` - Specific date
- \`dur(1 week)\` - Duration
- \`dateformat(date, "yyyy-MM-dd")\` - Format date

### List Functions
- \`length(list)\` - List length
- \`sum(numbers)\` - Sum of numbers
- \`min(numbers)\` - Minimum value
- \`max(numbers)\` - Maximum value

### Text Functions
- \`upper(text)\` - Uppercase
- \`lower(text)\` - Lowercase
- \`split(text, "separator")\` - Split text

## Sorting & Grouping

### SORT
\`\`\`
SORT file.mtime DESC
SORT rating ASC, file.name
SORT length(file.outlinks) DESC
\`\`\`

### GROUP BY
\`\`\`
GROUP BY file.folder
GROUP BY author
GROUP BY status
\`\`\`

### LIMIT
\`\`\`
LIMIT 10
LIMIT 5
\`\`\`

## Example Queries

### Project Management
\`\`\`
TABLE status, priority, file.mtime FROM #project 
WHERE status != "completed" 
SORT priority DESC, file.mtime DESC
\`\`\`

### Book Library
\`\`\`
TABLE author, rating, file.name FROM #books 
WHERE rating >= 4 
GROUP BY author 
SORT rating DESC
\`\`\`

### Daily Notes Analysis
\`\`\`
CALENDAR file.ctime FROM "Daily Notes" 
WHERE file.ctime >= date(today) - dur(30 days)
\`\`\`

### Task Tracking
\`\`\`
TASK FROM #todo 
WHERE !completed AND contains(text, "urgent")
SORT file.mtime DESC
\`\`\`

## Tips

1. **Performance**: Use WHERE clauses and LIMIT for large vaults
2. **Folders**: Use quotes for folder names with spaces
3. **Tags**: Prefix with # for tag queries
4. **Links**: Use [[Note Name]] syntax for link queries
5. **Custom Fields**: Define in YAML frontmatter of notes
6. **Dates**: Use ISO format (YYYY-MM-DD) for date fields
7. **Escaping**: Use backslashes for special characters in strings

## Common Patterns

### Find Recent Files
\`\`\`
LIST FROM "Notes" 
WHERE file.mtime >= date(today) - dur(7 days)
SORT file.mtime DESC
\`\`\`

### Files Without Tags
\`\`\`
LIST FROM "Notes" 
WHERE length(file.tags) = 0
\`\`\`

### High-Value Content
\`\`\`
TABLE rating, length(file.inlinks) AS "Backlinks"
FROM #important 
WHERE rating > 3 
SORT length(file.inlinks) DESC
\`\`\`
`;
  }
}

/**
 * Check if Dataview is available for tool registration
 */
export function isDataviewToolAvailable(api: ObsidianAPI): boolean {
  const detector = new PluginDetector(api.getApp());
  return detector.isDataviewAPIReady();
}