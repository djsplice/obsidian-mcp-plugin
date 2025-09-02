import { createSemanticTools } from '../src/tools/semantic-tools';

// Mock dataview-tool to force availability and control return value
jest.mock('../src/tools/dataview-tool', () => {
  return {
    isDataviewToolAvailable: jest.fn(() => true),
    DataviewTool: class {
      constructor(_: any) {}
      async executeQuery(query: string, _format?: string) {
        // Return an envelope with markdown to ensure semantic-tools prefers it
        return {
          success: true,
          title: 'Dataview Result',
          markdown: `MD for ${query}`,
          data: { type: 'list', result: { type: 'list', values: ['a', 'b'] } },
          meta: { type: 'dataview', count: 2 }
        };
      }
    }
  };
});

describe('semantic-tools dataview formatting', () => {
  test('prefers markdown from Dataview envelope', async () => {
    const api: any = { getApp: () => ({}) };
    const tools = createSemanticTools(api);
    const dv = tools.find(t => t.name === 'dataview');
    expect(dv).toBeTruthy();

    const res = await dv.handler(api, { action: 'query', query: 'LIST FROM #x' });
    expect(res.content?.[0]?.type).toBe('text');
    expect(res.content?.[0]?.text).toBe('MD for LIST FROM #x');
  });
});
