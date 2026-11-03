export interface SubmissionDraft { name: string; website: string; description: string; tags: string[]; }
export function publicWebsite(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
}
export function safeSearchTerm(value: string) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.hostname.includes('.') && !/\s/.test(value)) return url.hostname;
  } catch {}
  return value.trim().slice(0, 120);
}
export function readSubmissionDraft(key: string): SubmissionDraft | undefined {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined; } catch { return undefined; }
}
export function saveSubmissionDraft(key: string, draft: SubmissionDraft) {
  try { sessionStorage.setItem(key, JSON.stringify({ name: draft.name, website: publicWebsite(draft.website), description: draft.description, tags: draft.tags })); } catch {}
}
export function clearSubmissionDraft(key: string) {
  try { sessionStorage.removeItem(key); } catch {}
}
