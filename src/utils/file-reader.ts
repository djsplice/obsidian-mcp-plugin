import { ObsidianAPI } from './obsidian-api';
import { isImageFile } from '../types/obsidian';
import { UniversalFragmentRetriever } from '../indexing/fragment-retriever';
import { DEFAULT_LIMITS, mdEscape, toMarkdownTable, truncate } from '../tools/format';

interface FileReadOptions {
  path: string;
  returnFullFile?: boolean;
  query?: string;
  strategy?: 'auto' | 'adaptive' | 'proximity' | 'semantic';
  maxFragments?: number;
}

interface FileReadResult {
  content?: any;
  metadata?: any;
  originalContentLength?: number;
  fragmentMetadata?: {
    totalFragments: number;
    strategy: string;
    query: string;
  };
  workflow?: any;
  efficiency_hints?: any;
  warning?: string;
  // For image files
  base64Data?: string;
  mimeType?: string;
}

/**
 * Shared file reading logic with fragment support
 * Used by both classic tools and semantic operations
 */
export async function readFileWithFragments(
  api: ObsidianAPI,
  fragmentRetriever: UniversalFragmentRetriever,
  options: FileReadOptions
): Promise<FileReadResult> {
  const { path, returnFullFile, query, strategy, maxFragments } = options;
  
  // Get the file
  const fileResponse = await api.getFile(path);
  
  // Check if it's an image file
  if (isImageFile(fileResponse)) {
    // For images, preserve legacy return but add a tiny meta hint
    const resp = fileResponse as FileReadResult;
    return {
      ...resp,
      metadata: {
        ...(resp?.metadata || {}),
        previewType: 'image'
      }
    };
  }
  
  // Extract content from the response
  let fileContent: string;
  let metadata: any = {};
  
  if (typeof fileResponse === 'string') {
    fileContent = fileResponse;
  } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
    // Handle structured response from Obsidian API
    fileContent = fileResponse.content;
    metadata = fileResponse;
    
    // If it's still not a string (might be an image or binary file)
    if (typeof fileContent !== 'string') {
      return fileResponse as FileReadResult;
    }
  } else {
    // Handle other non-text files
    return fileResponse as FileReadResult;
  }
  
  // Return full file if requested
  if (returnFullFile) {
    const wordCount = fileContent.split(/\s+/).length;

    // Build markdown preview (truncated for safety)
    let mdPreview = '```markdown\n' + fileContent + '\n```';
    let truncated = false;
    const bytes = new TextEncoder().encode(mdPreview).length;
    if (bytes > DEFAULT_LIMITS.maxMarkdownBytes) {
      // Approximate truncation
      const approxCharLimit = DEFAULT_LIMITS.maxMarkdownBytes - 512;
      const sliced = fileContent.slice(0, approxCharLimit);
      mdPreview = '```markdown\n' + sliced + '\n\n… (truncated)\n```';
      truncated = true;
    }

    return {
      content: fileContent,
      metadata: {
        ...metadata,
        wordCount,
        warning: wordCount > 2000 ?
          `This file contains ${wordCount} words. Consider using fragment retrieval (remove returnFullFile parameter) to reduce context consumption.` :
          null,
        // New standardized meta additions (non-breaking)
        markdown: mdPreview,
        meta: {
          type: 'file',
          source: path,
          count: wordCount,
          truncated
        }
      }
    };
  }
  
  // Use fragment retrieval
  const docId = `file:${path}`;
  await fragmentRetriever.indexDocument(docId, path, fileContent);
  
  // Retrieve relevant fragments based on query or path
  const fragmentQuery = query || path.split('/').pop()?.replace('.md', '') || '';
  const fragmentResponse = await fragmentRetriever.retrieveFragments(fragmentQuery, {
    strategy: strategy || 'auto',
    maxFragments: maxFragments || 5
  });
  
  // Build a markdown table preview for fragments
  const rows = (fragmentResponse.result || []).map((f) => ({
    path: f.docPath,
    lines: `${f.lineStart}-${f.lineEnd}`,
    score: Math.round((f.score ?? 0) * 100) / 100,
    preview: truncate(f.content, DEFAULT_LIMITS.maxText)
  }));
  const markdown = toMarkdownTable(rows, {
    maxRows: DEFAULT_LIMITS.maxRows,
    maxCols: DEFAULT_LIMITS.maxCols,
    maxText: DEFAULT_LIMITS.maxText
  });

  // Return structured response with fragments + standardized preview/meta fields (non-breaking additions)
  return {
    ...metadata,
    content: fragmentResponse.result,
    originalContentLength: fileContent.length,
    fragmentMetadata: {
      totalFragments: fragmentResponse.result.length,
      strategy: strategy || 'auto',
      query: fragmentQuery
    },
    workflow: fragmentResponse.workflow,
    efficiency_hints: fragmentResponse.efficiency_hints,
    // New additions
    markdown,
    meta: {
      type: 'fragments',
      source: path,
      count: fragmentResponse.result.length,
      strategy: strategy || 'auto',
      query: fragmentQuery,
      truncated: rows.length > DEFAULT_LIMITS.maxRows
    }
  };
}