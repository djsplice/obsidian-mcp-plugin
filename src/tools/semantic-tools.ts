import { ObsidianAPI } from '../utils/obsidian-api';
import { SemanticRouter } from '../semantic/router';
import { SemanticRequest } from '../types/semantic';
import { isImageFile } from '../utils/image-handler';
import { isImageFile as isImageFileObject } from '../types/obsidian';
import { App } from 'obsidian';
import { DataviewTool, isDataviewToolAvailable } from './dataview-tool';
import { mdEscape, truncate, DEFAULT_LIMITS } from './format';

// --- Generic formatting helpers for MCP output ---
function toMarkdownForOperation(operation: string, action: string, response: any): string {
  if (!response) return 'No result.';
  
  // Handle different operation types
  switch (operation) {
    case 'vault':
      return formatVaultResponse(action, response);
    case 'graph':
      return formatGraphResponse(action, response);
    case 'search':
      return formatSearchResponse(response);
    default:
      return formatGenericResponse(response);
  }
}

function formatVaultResponse(action: string, response: any): string {
  const result = response.result || response;
  
  switch (action) {
    case 'list': {
      const files = Array.isArray(result) ? result : [];
      const header = `### Files (${files.length})`;
      const items = files.slice(0, DEFAULT_LIMITS.maxRows).map((f: string) => `- ${f}`);
      const truncated = files.length > DEFAULT_LIMITS.maxRows ? `\n… and ${files.length - DEFAULT_LIMITS.maxRows} more` : '';
      return `${header}\n\n${items.join('\n')}${truncated}`;
    }
    case 'search': {
      const searchResult = result.results || result;
      if (!Array.isArray(searchResult)) return 'No search results.';
      
      const header = `### Search Results (${result.totalResults || searchResult.length})`;
      const items = searchResult.slice(0, DEFAULT_LIMITS.maxRows).map((r: any) => 
        `- **${r.title || r.path}** ${r.score ? `(${r.score})` : ''}\n  \`${r.path}\``
      );
      const truncated = searchResult.length > DEFAULT_LIMITS.maxRows ? `\n… and ${searchResult.length - DEFAULT_LIMITS.maxRows} more` : '';
      return `${header}\n\n${items.join('\n')}${truncated}`;
    }
    case 'fragments': {
      const fragments = Array.isArray(result) ? result : [];
      if (fragments.length === 0) return 'No relevant fragments found.';
      
      const header = `### Fragments (${fragments.length})`;
      const items = fragments.slice(0, DEFAULT_LIMITS.maxRows).map((f: any, i: number) => {
        const lines = f.lineStart && f.lineEnd ? ` (lines ${f.lineStart}-${f.lineEnd})` : '';
        const score = f.score ? ` - Score: ${Math.round(f.score * 100)}%` : '';
        const content = f.content ? `\n\n${f.content}` : '';
        return `#### Fragment ${i + 1}${lines}${score}${content}`;
      });
      const truncated = fragments.length > DEFAULT_LIMITS.maxRows ? `\n\n… and ${fragments.length - DEFAULT_LIMITS.maxRows} more fragments` : '';
      return `${header}\n\n${items.join('\n\n')}${truncated}`;
    }
    default:
      return formatGenericResponse(response);
  }
}

function formatGraphResponse(action: string, response: any): string {
  const result = response.result || response;
  
  switch (action) {
    case 'neighbors':
    case 'traverse': {
      const nodes = result.nodes || [];
      const edges = result.edges || [];
      const header = `### Graph ${action === 'neighbors' ? 'Neighbors' : 'Traversal'} (${nodes.length} nodes, ${edges.length} connections)`;
      
      const nodeItems = nodes.slice(0, DEFAULT_LIMITS.maxRows).map((n: any) => 
        `- **${n.title || n.path}** (${n.links?.total || 0} links)\n  \`${n.path}\``
      );
      const truncated = nodes.length > DEFAULT_LIMITS.maxRows ? `\n… and ${nodes.length - DEFAULT_LIMITS.maxRows} more nodes` : '';
      
      return `${header}\n\n${nodeItems.join('\n')}${truncated}`;
    }
    case 'statistics': {
      const stats = result.statistics || result;
      return `### Graph Statistics\n\n- **Total files**: ${stats.totalFiles || 0}\n- **Total links**: ${stats.totalLinks || 0}\n- **Orphaned files**: ${stats.orphanedFiles || 0}\n- **Most connected**: ${stats.mostConnected?.title || 'None'} (${stats.mostConnected?.connections || 0} links)`;
    }
    default:
      return formatGenericResponse(response);
  }
}

function formatSearchResponse(response: any): string {
  // Fallback for generic search formatting
  return formatVaultResponse('search', response);
}

function formatGenericResponse(response: any): string {
  const result = response.result || response;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const items = result.slice(0, DEFAULT_LIMITS.maxRows).map((item: any) => `- ${String(item)}`);
    const truncated = result.length > DEFAULT_LIMITS.maxRows ? `\n… and ${result.length - DEFAULT_LIMITS.maxRows} more` : '';
    return `### Results (${result.length})\n\n${items.join('\n')}${truncated}`;
  }
  
  // For objects, try to extract meaningful content
  const keys = Object.keys(result).slice(0, 5);
  return `### Result\n\n${keys.map(k => `- **${k}**: ${String(result[k])}`).join('\n')}`;
}

function toMarkdownForDataview(query: string, payload: any): string {
  // payload is the object returned by DataviewTool.executeQuery()
  // shape: { success, query, format, result, type, workflow, hints }
  if (!payload) return 'No result.';
  const header = `Dataview • ${payload.type?.toUpperCase?.() || 'RESULT'}`;
  const meta = `Query: ${'`' + (payload.query || query) + '`'}`;
  const result = payload.result;

  const MAX_ROWS = DEFAULT_LIMITS.maxRows;
  const MAX_TEXT = DEFAULT_LIMITS.maxText;

  let body = '';
  if (!result) {
    body = '_Empty result_';
  } else {
    switch (result.type) {
      case 'list': {
        const items: any[] = Array.isArray(result.values) ? result.values : [];
        const shown = items.slice(0, MAX_ROWS);
        const renderItem = (v: any): string => {
          if (v == null) return '';
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
          // try meaningful fields
          const text = v.text ?? v.title ?? v.name ?? v.display;
          const path = v.path ?? v.file?.path;
          if (text && path) return `${text} (${path})`;
          if (text) return String(text);
          if (path) return String(path);
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        };
        body = shown.map((v) => `- ${truncate(renderItem(v), MAX_TEXT)}`).join('\n');
        if (items.length > shown.length) body += `\n… and ${items.length - shown.length} more`;
        break;
      }
      case 'table': {
        const headersRaw: any[] = Array.isArray(result.headers) ? result.headers : [];
        const headers: string[] = headersRaw.map(h => String(h));
        const rowsRaw: any = Array.isArray(result.values) ? result.values : (result?.value ?? result?.rows ?? []);

        const toArray = (x: any): any[] => Array.isArray(x)
          ? x
          : (x && typeof x.array === 'function')
            ? x.array()
            : [];

        const getByPath = (obj: any, path: string) => {
          if (!obj) return undefined;
          const parts = String(path).split('.');
          let cur = obj;
          for (const p of parts) {
            if (cur == null) return undefined;
            cur = cur[p];
          }
          return cur;
        };

        const rowToArray = (r: any): any[] => {
          if (Array.isArray(r)) return r;
          if (r && typeof r.array === 'function') return r.array();
          if (r?.values) return toArray(r.values);
          if (r?.row) return toArray(r.row);
          if (r?.cells) return toArray(r.cells);
          if (!headers.length) return [];
          // Resolve header paths against object
          return headers.map((h) => {
            // Special-case File header
            if (h.toLowerCase() === 'file') {
              const name = r?.file?.name ?? r?.name ?? r?.fileName ?? r?.basename;
              const path = r?.file?.path ?? r?.path;
              return name && path ? `[[${path}|${name}]]` : (name ?? path ?? '');
            }
            const v = getByPath(r, h);
            return v;
          });
        };

        const printable = (v: any): string => {
          if (v == null) return '';
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
          if (v?.path && (v?.display || v?.name)) {
            const disp = v.display ?? v.name;
            return `[[${v.path}|${disp}]]`;
          }
          if (v?.toISOString && typeof v.toISOString === 'function') {
            try { return v.toISOString(); } catch {}
          }
          try { return JSON.stringify(v); } catch { return String(v); }
        };

        const rowsArr: any[][] = toArray(rowsRaw).map(rowToArray);
        const shown = rowsArr.slice(0, MAX_ROWS);

        if (headers.length) {
          body += `| ${headers.map(h => mdEscape(h)).join(' | ')} |\n`;
          body += `| ${headers.map(() => '---').join(' | ')} |\n`;
          body += shown.map(r => `| ${r.map(c => mdEscape(truncate(printable(c), MAX_TEXT))).join(' | ')} |`).join('\n');
        } else {
          body += shown.map(r => `- ${r.map(c => truncate(printable(c), MAX_TEXT)).join(' • ')}`).join('\n');
        }
        if (rowsArr.length > shown.length) body += `\n… and ${rowsArr.length - shown.length} more rows`;
        break;
      }
      case 'task': {
        const tasks: any[] = Array.isArray(result.values) ? result.values : [];
        const shown = tasks.slice(0, MAX_ROWS);
        body = shown.map(t => `- [${t.completed ? 'x' : ' '}] ${truncate(t.text || '', MAX_TEXT)} (${t.path ?? ''}${typeof t.line === 'number' ? `:${t.line}` : ''})`).join('\n');
        if (tasks.length > shown.length) body += `\n… and ${tasks.length - shown.length} more tasks`;
        break;
      }
      default: {
        // unknown or calendar or any other complex structure: keep it concise
        const candidate: any = (result?.values ?? result?.value ?? result?.rows ?? result?.tasks ?? result);
        const arr = Array.isArray(candidate)
          ? candidate
          : (candidate && typeof candidate.array === 'function')
            ? candidate.array()
            : [];
        const count = Array.isArray(arr) ? arr.length : 0;
        const sample = arr[0] || (candidate && typeof candidate === 'object' ? candidate : undefined);
        const sampleKeys = sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 8) : [];
        body = `Result contains ${count} item(s).` + (sampleKeys.length ? ` Sample keys: ${sampleKeys.join(', ')}.` : '');
      }
    }
  }

  // Optional workflow suggestions
  let suggestions = '';
  const suggested = payload.workflow?.suggested_next as any[] | undefined;
  if (suggested?.length) {
    const shown = suggested.slice(0, 3);
    suggestions = ['\n\nSuggested next actions:', ...shown.map(s => `- ${s.description || ''}\n  • ${s.command || ''}`)].join('\n');
  }

  return `### ${header}\n\n${meta}\n\n${body}${suggestions}`.trim();
}

/**
 * Unified semantic tools that consolidate all operations into 5 main verbs
 */

const createSemanticTool = (operation: string) => ({
  name: operation,
  description: getOperationDescription(operation),
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The specific action to perform',
        enum: getActionsForOperation(operation)
      },
      ...getParametersForOperation(operation)
    },
    required: ['action']
  },
  handler: async (api: ObsidianAPI, args: any) => {
    const app = api.getApp();
    
    // Check for read-only mode before processing write operations
    if ((api as any).plugin?.settings?.readOnlyMode && operation === 'vault') {
      const writeOperations = ['create', 'update', 'delete', 'move', 'rename', 'copy', 'split', 'combine', 'concatenate'];
      if (writeOperations.includes(args.action)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                code: 'READ_ONLY_MODE',
                message: `Write operation '${args.action}' is blocked - read-only mode is enabled`
              },
              context: {
                readOnlyMode: true,
                operation: operation,
                action: args.action,
                blockedOperation: true
              }
            }, null, 2)
          }]
        };
      }
    }
    
    // Handle Dataview operations separately
    if (operation === 'dataview') {
      const dataviewTool = new DataviewTool(api);
      let result;

      switch (args.action) {
        case 'status':
          result = {
            result: dataviewTool.getStatus(),
            context: { operation, action: args.action }
          };
          break;
        case 'query': {
          if (!args.query) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Query parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const queryResult = await dataviewTool.executeQuery(args.query, args.format);
            result = {
              result: queryResult,
              context: { operation, action: args.action, query: args.query }
            };
          }
          break;
        }
        case 'list': {
          const listResult = await dataviewTool.listPages(args.source);
          result = {
            result: listResult,
            context: { operation, action: args.action, source: args.source }
          };
          break;
        }
        case 'metadata': {
          if (!args.path) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Path parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const metadataResult = await dataviewTool.getPageMetadata(args.path);
            result = {
              result: metadataResult,
              context: { operation, action: args.action, path: args.path }
            };
          }
          break;
        }
        case 'validate': {
          if (!args.query) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Query parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const validateResult = await dataviewTool.validateQuery(args.query);
            result = {
              result: validateResult,
              context: { operation, action: args.action, query: args.query }
            };
          }
          break;
        }
        default:
          result = {
            error: { code: 'INVALID_ACTION', message: `Unknown Dataview action: ${args.action}` },
            context: { operation, action: args.action }
          };
      }

      // Format Dataview response for MCP
      if (result.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: result.error,
              context: result.context
            }, null, 2)
          }],
          isError: true
        };
      }

      try {
        const resp = result.result as any;
        const mdFromEnvelope: string | undefined = resp?.markdown;
        const md = mdFromEnvelope || toMarkdownForDataview(args.query, resp);
        return {
          content: [{
            type: 'text' as const,
            text: md
          }]
        };
      } catch (e) {
        // Fallback to JSON if formatting fails
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ result: result.result, context: result.context }, null, 2)
          }]
        };
      }
    }

    const router = new SemanticRouter(api, app);
    
    const request: SemanticRequest = {
      operation,
      action: args.action,
      params: args
    };
    
    const response = await router.route(request);
    
    // Format for MCP
    if (response.error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: response.error,
            workflow: response.workflow,
            context: response.context
          }, null, 2)
        }],
        isError: true
      };
    }
    
    // Check if the result is an image file for vault read operations
    if (operation === 'vault' && args.action === 'read' && response.result && isImageFileObject(response.result)) {
      // Return image content for MCP
      return {
        content: [{
          type: 'image' as const,
          data: response.result.base64Data,
          mimeType: response.result.mimeType
        }]
      };
    }
    
    // Fallback for vault.read where content is not a string (e.g., empty array from fragment flow)
    if (operation === 'vault' && args.action === 'read' && response.result && typeof (response.result as any).content !== 'string') {
      try {
        const fallbackRequest: SemanticRequest = {
          operation,
          action: args.action,
          params: { ...args, returnFullFile: true, includeContent: true }
        };
        const fallback = await router.route(fallbackRequest);
        if (fallback?.result && typeof (fallback.result as any).content === 'string') {
          return {
            content: [{
              type: 'text' as const,
              text: (fallback.result as any).content
            }]
          };
        }
      } catch (e) {
        // proceed to normal formatting below
      }
    }

    // For vault.read on text/markdown notes, return the markdown content directly
    if (operation === 'vault' && args.action === 'read' && response.result && typeof (response.result as any).content === 'string') {
      return {
        content: [{
          type: 'text' as const,
          text: (response.result as any).content
        }]
      };
    }

    // Only filter image files if they contain binary data that would cause JSON errors
    // For search results, we want to show image files in the results list
    const filteredResult = response.result;
    
    // Special handling for image files in view operations
    if (operation === 'view' && args.action === 'file' && filteredResult && filteredResult.base64Data) {
      return {
        content: [{
          type: 'image' as const,
          data: filteredResult.base64Data,
          mimeType: filteredResult.mimeType
        }]
      };
    }

    // For view.file on text/markdown notes, return the markdown content directly
    if (operation === 'view' && args.action === 'file' && filteredResult && typeof filteredResult.content === 'string') {
      return {
        content: [{
          type: 'text' as const,
          text: filteredResult.content
        }]
      };
    }
    
    try {
      // Use direct markdown formatting instead of JSON wrapper
      const markdown = toMarkdownForOperation(operation, args.action, {
        result: filteredResult,
        workflow: response.workflow,
        context: response.context,
        efficiency_hints: response.efficiency_hints
      });
      
      return {
        content: [{
          type: 'text' as const,
          text: markdown
        }]
      };
    } catch (error) {
      // Handle formatting errors
      console.error('Response formatting failed:', error);
      return {
        content: [{
          type: 'text' as const,
          text: `Error: Unable to format response. ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
});

function filterImageFilesFromSearchResults(searchResult: any): any {
  if (!searchResult) return searchResult;
  
  // Handle paginated search results format
  if (searchResult.results && Array.isArray(searchResult.results)) {
    return {
      ...searchResult,
      results: searchResult.results.filter((result: any) => {
        // Filter out results that reference image files
        if (result.filename && typeof result.filename === 'string' && isImageFile(result.filename)) {
          return false;
        }
        if (result.path && typeof result.path === 'string' && isImageFile(result.path)) {
          return false;
        }
        return true;
      })
    };
  }
  
  // Handle simple search results format (array of results)
  if (Array.isArray(searchResult)) {
    return searchResult.filter((result: any) => {
      if (result.filename && typeof result.filename === 'string' && isImageFile(result.filename)) {
        return false;
      }
      if (result.path && typeof result.path === 'string' && isImageFile(result.path)) {
        return false;
      }
      return true;
    });
  }
  
  return searchResult;
}

function getOperationDescription(operation: string): string {
  const descriptions: Record<string, string> = {
    vault: '📁 File operations - list, read, create, update, delete, search, fragments, move, rename, copy, split, combine, concatenate. Search supports operators: file:, path:, content:, tag:. OR for multiple terms. "quoted phrases". /regex/. Results ranked by relevance.',
    edit: '✏️ Edit files - window: find/replace with fuzzy matching, append: add to end, patch: modify headings/blocks/frontmatter, at_line: insert at line number, from_buffer: reuse previous window content',
    view: '👁️ View content - file: entire document, window: ~20 lines around point, active: current editor file, open_in_obsidian: launch in app',
    workflow: '💡 Get contextual suggestions for next actions based on current state',
    system: 'ℹ️ System operations - info: server details, commands: available actions, fetch_web: retrieve and process web content',
    graph: '🕸️ Graph navigation - traverse: explore connections, neighbors: immediate links, path: find routes between notes, statistics: link counts, backlinks/forwardlinks: directional analysis, search-traverse: connected snippets',
    dataview: '📊 Dataview operations - query: execute DQL queries (LIST FROM "folder", TABLE field FROM #tag WHERE condition), list: get pages with metadata and frontmatter, metadata: extract complete page metadata, validate: check DQL syntax, status: plugin availability. Supports LIST, TABLE, TASK, CALENDAR queries with WHERE filters, sorting, grouping.',
    bases: '🗃️ Bases operations - list: show all .base files, read: get YAML config, create: new base with views/filters/formulas, query: execute filters on vault notes, view: get table/card view data, evaluate: test formulas, export: CSV/JSON/Markdown. Bases use YAML format with expression-based filters like status == "active" and file.hasTag("project")'
  };
  return descriptions[operation] || 'Unknown operation';
}

function getActionsForOperation(operation: string): string[] {
  const actions: Record<string, string[]> = {
    vault: ['list', 'read', 'create', 'update', 'delete', 'search', 'fragments', 'move', 'rename', 'copy', 'split', 'combine', 'concatenate'],
    edit: ['window', 'append', 'patch', 'at_line', 'from_buffer'],
    view: ['file', 'window', 'active', 'open_in_obsidian'],
    workflow: ['suggest'],
    system: ['info', 'commands', 'fetch_web'],
    graph: ['traverse', 'neighbors', 'path', 'statistics', 'backlinks', 'forwardlinks', 'search-traverse', 'advanced-traverse', 'tag-traverse', 'tag-analysis', 'shared-tags'],
    dataview: ['query', 'list', 'metadata', 'validate', 'status'],
    bases: ['list', 'read', 'create', 'query', 'view', 'export']
  };
  return actions[operation] || [];
}

function getParametersForOperation(operation: string): Record<string, any> {
  // Common parameters across operations
  const pathParam = {
    path: {
      type: 'string',
      description: 'File path relative to vault root'
    }
  };
  
  const contentParam = {
    content: {
      type: 'string',
      description: 'Text content to write (markdown supported)'
    }
  };
  
  // Operation-specific parameters
  const operationParams: Record<string, Record<string, any>> = {
    vault: {
      ...pathParam,
      directory: {
        type: 'string',
        description: 'Directory path for list operations'
      },
      query: {
        type: 'string',
        description: 'Search query'
      },
      page: {
        type: 'number',
        description: 'Page number for paginated results'
      },
      pageSize: {
        type: 'number',
        description: 'Number of results per page'
      },
      strategy: {
        type: 'string',
        enum: ['auto', 'adaptive', 'proximity', 'semantic'],
        description: 'Fragment retrieval strategy (default: auto)'
      },
      maxFragments: {
        type: 'number',
        description: 'Maximum number of fragments to return (default: 5)'
      },
      returnFullFile: {
        type: 'boolean',
        description: 'Return full file instead of fragments (WARNING: large files can consume significant context)'
      },
      includeContent: {
        type: 'boolean',
        description: 'Include file content in search results (slower but more thorough)'
      },
      destination: {
        type: 'string',
        description: 'Destination path for move/copy operations'
      },
      newName: {
        type: 'string',
        description: 'New filename for rename operation (without path)'
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite if destination exists (default: false)'
      },
      // Split operation parameters
      splitBy: {
        type: 'string',
        enum: ['heading', 'delimiter', 'lines', 'size'],
        description: 'Split strategy: heading (by markdown headings), delimiter (by custom string), lines (by line count), size (by character count)'
      },
      delimiter: {
        type: 'string',
        description: 'Delimiter string/regex for delimiter strategy (default: "---")'
      },
      level: {
        type: 'number',
        description: 'Heading level for heading strategy (1-6)'
      },
      linesPerFile: {
        type: 'number',
        description: 'Number of lines per file for lines strategy (default: 100)'
      },
      maxSize: {
        type: 'number',
        description: 'Max characters per file for size strategy (default: 10000)'
      },
      outputPattern: {
        type: 'string',
        description: 'Naming pattern for output files (default: "{filename}-{index}{ext}")'
      },
      outputDirectory: {
        type: 'string',
        description: 'Directory for output files (defaults to source directory)'
      },
      // Combine operation parameters
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of file paths to combine'
      },
      separator: {
        type: 'string',
        description: 'Content separator between files (default: "\\n\\n---\\n\\n")'
      },
      includeFilenames: {
        type: 'boolean',
        description: 'Include source filenames as headers (default: false)'
      },
      sortBy: {
        type: 'string',
        enum: ['name', 'modified', 'created', 'size'],
        description: 'Sort files before combining'
      },
      sortOrder: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort order (default: "asc")'
      },
      // Concatenate operation parameters
      path1: {
        type: 'string',
        description: 'First file path for concatenation'
      },
      path2: {
        type: 'string',
        description: 'Second file path for concatenation'
      },
      mode: {
        type: 'string',
        enum: ['append', 'prepend', 'new'],
        description: 'Concatenation mode: append to path1, prepend to path1, or create new file'
      },
      ...contentParam
    },
    edit: {
      ...pathParam,
      ...contentParam,
      oldText: {
        type: 'string',
        description: 'Text to search for (supports fuzzy matching)'
      },
      newText: {
        type: 'string',
        description: 'Text to replace with'
      },
      fuzzyThreshold: {
        type: 'number',
        description: 'Similarity threshold for fuzzy matching (0-1)',
        default: 0.7
      },
      lineNumber: {
        type: 'number',
        description: 'Line number for at_line action'
      },
      mode: {
        type: 'string',
        enum: ['before', 'after', 'replace'],
        description: 'Insert mode for at_line action'
      },
      operation: {
        type: 'string',
        enum: ['append', 'prepend', 'replace'],
        description: 'Patch operation: append (add after), prepend (add before), or replace'
      },
      targetType: {
        type: 'string',
        enum: ['heading', 'block', 'frontmatter'],
        description: 'Structure to target: heading (use :: for nesting), block (by ID), or frontmatter (field name)'
      },
      target: {
        type: 'string',
        description: 'Target identifier (e.g., "Section::Subsection", "blockId", "status")'
      }
    },
    view: {
      ...pathParam,
      searchText: {
        type: 'string',
        description: 'Text to search for and highlight'
      },
      lineNumber: {
        type: 'number',
        description: 'Line number to center view around'
      },
      windowSize: {
        type: 'number',
        description: 'Number of lines to show',
        default: 20
      }
    },
    workflow: {
      type: {
        type: 'string',
        description: 'Type of analysis or workflow'
      }
    },
    system: {
      url: {
        type: 'string',
        description: 'URL to fetch and convert to markdown'
      }
    },
    graph: {
      sourcePath: {
        type: 'string',
        description: 'Starting file path for graph operations'
      },
      targetPath: {
        type: 'string',
        description: 'Target file path (for path finding operations)'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for traversal (default: 3)'
      },
      maxNodes: {
        type: 'number',
        description: 'Maximum number of nodes to return (default: 50)'
      },
      includeUnresolved: {
        type: 'boolean',
        description: 'Include unresolved links in the results'
      },
      followBacklinks: {
        type: 'boolean',
        description: 'Follow backlinks during traversal (default: true)'
      },
      followForwardLinks: {
        type: 'boolean',
        description: 'Follow forward links during traversal (default: true)'
      },
      followTags: {
        type: 'boolean',
        description: 'Follow tag connections during traversal'
      },
      fileFilter: {
        type: 'string',
        description: 'Regex pattern to filter file names'
      },
      tagFilter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include files with these tags'
      },
      folderFilter: {
        type: 'string',
        description: 'Only include files in this folder'
      },
      // Graph search traversal parameters
      startPath: {
        type: 'string',
        description: 'Starting document path for search traversal'
      },
      searchQuery: {
        type: 'string',
        description: 'Search query to apply at each node (for search-traverse)'
      },
      searchQueries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple search queries (for advanced-traverse)'
      },
      maxSnippetsPerNode: {
        type: 'number',
        description: 'Maximum snippets to extract per node (default: 2)'
      },
      scoreThreshold: {
        type: 'number',
        description: 'Minimum score threshold for including nodes (0-1, default: 0.5)'
      },
      strategy: {
        type: 'string',
        enum: ['breadth-first', 'best-first', 'beam-search'],
        description: 'Traversal strategy (for advanced-traverse)'
      },
      beamWidth: {
        type: 'number',
        description: 'Beam width for beam-search strategy'
      },
      includeOrphans: {
        type: 'boolean',
        description: 'Include orphaned notes in traversal'
      },
      filePattern: {
        type: 'string',
        description: 'Filter traversal to files matching this pattern'
      },
      // Tag-based graph parameters
      tagWeight: {
        type: 'number',
        description: 'Weight factor for tag connections (0-1, default: 0.8)'
      }
    },
    dataview: {
      query: {
        type: 'string',
        description: 'DQL query string. Examples: "LIST FROM #project WHERE status = \\"active\\"", "TABLE file.size, rating FROM \\"Notes\\" WHERE rating > 3 SORT file.mtime DESC", "TASK FROM #todo WHERE !completed", "CALENDAR file.ctime FROM \\"Daily Notes\\""'
      },
      format: {
        type: 'string',
        enum: ['dql'],
        description: 'Query format (currently only DQL supported)',
        default: 'dql'
      },
      source: {
        type: 'string',
        description: 'Source filter for pages. Examples: "folder/path" (folder), "#tag" (tag), "[[Note Name]]" (backlinks), "" (all pages)'
      },
      ...pathParam
    },
    bases: {
      path: {
        type: 'string',
        description: 'Path to the .base file'
      },
      config: {
        type: 'object',
        description: 'Base configuration object with name, source, properties, and views'
      },
      viewName: {
        type: 'string',
        description: 'Name of the view to retrieve'
      },
      filters: {
        type: 'array',
        description: 'Array of filter objects with property, operator, and value'
      },
      sort: {
        type: 'object',
        description: 'Sort options with property and order (asc/desc)'
      },
      pagination: {
        type: 'object',
        description: 'Pagination options with page and pageSize'
      },
      includeContent: {
        type: 'boolean',
        description: 'Include note content in results'
      },
      properties: {
        type: 'array',
        description: 'Specific properties to include in results'
      },
      basePath: {
        type: 'string',
        description: 'Path to the base for template generation'
      },
      template: {
        type: 'object',
        description: 'Template configuration with name, folder, properties, and contentTemplate'
      },
      format: {
        type: 'string',
        enum: ['csv', 'json', 'markdown'],
        description: 'Export format'
      },
      dateFormat: {
        type: 'string',
        description: 'Date format for export (e.g., YYYY-MM-DD)'
      }
    }
  };
  
  return operationParams[operation] || {};
}

/**
 * Create semantic tools array with optional Dataview support
 */
export function createSemanticTools(api?: ObsidianAPI): any[] {
  const baseTools = [
    createSemanticTool('vault'),
    createSemanticTool('edit'),
    createSemanticTool('view'),
    createSemanticTool('workflow'),
    createSemanticTool('system'),
    createSemanticTool('graph'),
    createSemanticTool('bases')
  ];

  // Add Dataview tool if available
  if (api && isDataviewToolAvailable(api)) {
    baseTools.push(createSemanticTool('dataview'));
  }

  return baseTools;
}

// Export the base 6 semantic tools (for backward compatibility)
export const semanticTools = [
  createSemanticTool('vault'),
  createSemanticTool('edit'),
  createSemanticTool('view'),
  createSemanticTool('workflow'),
  createSemanticTool('system'),
  createSemanticTool('graph'),
  createSemanticTool('bases')
];