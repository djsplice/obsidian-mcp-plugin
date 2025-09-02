import { readFileWithFragments } from '../src/utils/file-reader';
import { UniversalFragmentRetriever } from '../src/indexing/fragment-retriever';

// Simple mock type for ObsidianAPI with getFile()
type MockAPI = { getFile: (path: string) => any };

describe('readFileWithFragments formatting', () => {
  test('full-file mode adds markdown preview and meta in metadata', async () => {
    const api: MockAPI = {
      getFile: async () => ({ content: '# Title\nSome content here.' })
    };

    const retriever = {
      indexDocument: jest.fn(),
      retrieveFragments: jest.fn()
    } as unknown as UniversalFragmentRetriever;

    const res = await readFileWithFragments(api as any, retriever, {
      path: 'note.md',
      returnFullFile: true
    });

    expect(typeof res.content).toBe('string');
    expect(res.metadata).toBeTruthy();
    expect(res.metadata.wordCount).toBeGreaterThan(0);
    // New additions live in metadata for full-file path
    expect(typeof res.metadata.markdown).toBe('string');
    expect(res.metadata.meta).toMatchObject({ type: 'file', source: 'note.md' });
  });

  test('fragment mode adds top-level markdown and meta with counts', async () => {
    const api: MockAPI = {
      getFile: async () => ({ content: 'A file with multiple sections and keywords.' })
    };

    const fragments = [
      {
        id: 'f1', docId: 'd1', docPath: 'note.md', content: 'fragment one content',
        score: 0.9, lineStart: 1, lineEnd: 5
      },
      {
        id: 'f2', docId: 'd1', docPath: 'note.md', content: 'fragment two content',
        score: 0.75, lineStart: 10, lineEnd: 15
      }
    ];

    const retriever = {
      indexDocument: jest.fn(async () => {}),
      retrieveFragments: jest.fn(async () => ({
        result: fragments,
        workflow: { message: 'Found fragments' },
        efficiency_hints: { message: 'Auto-selected strategy' }
      }))
    } as unknown as UniversalFragmentRetriever;

    const res = await readFileWithFragments(api as any, retriever, {
      path: 'note.md',
      strategy: 'adaptive',
      maxFragments: 5
    });

    // Legacy fields preserved
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.fragmentMetadata?.totalFragments).toBe(2);
    expect(res.workflow).toBeTruthy();

    // New standardized preview/meta
    expect(typeof (res as any).markdown).toBe('string');
    expect((res as any).meta).toMatchObject({
      type: 'fragments',
      source: 'note.md',
      count: 2,
      strategy: 'adaptive'
    });
  });
});
