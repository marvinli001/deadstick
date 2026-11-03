import { describe, expect, it, vi } from 'vitest';
import { miniAppPath } from '../web/src/lib/telegram.js';
import { readSubmissionDraft, saveSubmissionDraft, safeSearchTerm, publicWebsite } from '../web/src/lib/submissionDraft.js';

describe('submission entry and drafts', () => {
  it('opens only well-formed existing-provider report links', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    expect(miniAppPath(`report_${id.replace(/-/g,'')}`)).toBe(`/submit?provider=${id}`);
    expect(miniAppPath('report_../../console')).toBeUndefined();
    expect(miniAppPath('report_123')).toBeUndefined();
  });
  it('retains only non-sensitive draft fields and strips URL parameters from search and website prefill', () => {
    const values = new Map<string,string>();
    vi.stubGlobal('sessionStorage', { getItem: (key:string) => values.get(key), setItem: (key:string,value:string) => values.set(key,value) });
    const secret = 'https://example.com/path?token=YOUR_PRIVATE_TOKEN#fragment';
    const draft = { name:'全中文机场',website:secret,description:'介绍',tags:['中文'],subscription:secret };
    saveSubmissionDraft('draft',draft);
    expect(values.get('draft')).not.toContain('YOUR_PRIVATE_TOKEN');
    expect(values.get('draft')).not.toContain('subscription');
    expect(readSubmissionDraft('draft')).toEqual({name:draft.name,website:'https://example.com/path',description:'介绍',tags:['中文']});
    expect(safeSearchTerm(secret)).toBe('example.com');
    expect(publicWebsite('javascript:alert(1)')).toBe('');
    expect(publicWebsite('https://user:password@example.com')).toBe('');
    vi.unstubAllGlobals();
  });
});
