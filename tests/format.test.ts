import { DEFAULT_LIMITS, toMarkdownList, toMarkdownTable, errorToResponse, makeResponse } from '../src/tools/format';

describe('formatter utilities', () => {
  test('toMarkdownList truncates with extra count', () => {
    const items = Array.from({ length: DEFAULT_LIMITS.maxRows + 3 }, (_, i) => `item ${i+1}`);
    const md = toMarkdownList(items);
    expect(md.split('\n').length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxRows + 1);
    expect(md).toContain('… (3 more)');
  });

  test('toMarkdownTable renders headers and truncates cells and rows', () => {
    const rows = Array.from({ length: DEFAULT_LIMITS.maxRows + 2 }, (_, i) => ({
      name: `row|${i+1}`,
      description: 'x'.repeat(DEFAULT_LIMITS.maxText + 50),
      extra: `col-${i+1}`,
      ignored: 'should be truncated by columns',
    }));
    const md = toMarkdownTable(rows);
    // Header present
    expect(md.startsWith('| ')).toBe(true);
    // Escapes pipe in header or cells
    expect(md).toContain('row\\|1');
    // Shows extra rows marker
    expect(md).toContain('more rows');
  });

  test('errorToResponse returns standardized error envelope', () => {
    const resp = errorToResponse(new Error('boom'), { title: 'My Tool' });
    expect(resp.success).toBe(false);
    expect(resp.title).toBe('My Tool');
    expect(resp.meta?.error).toBe(true);
    expect(resp.markdown).toContain('❌');
    expect(resp.data).toEqual({ error: 'boom' });
  });

  test('makeResponse enforces max markdown bytes (truncated flag)', () => {
    const huge = '# Title\n' + 'a'.repeat(DEFAULT_LIMITS.maxMarkdownBytes + 2048);
    const resp = makeResponse({ success: true, markdown: huge });
    expect(resp.markdown).toContain('… (truncated)');
    expect(resp.meta?.truncated).toBe(true);
  });
});
