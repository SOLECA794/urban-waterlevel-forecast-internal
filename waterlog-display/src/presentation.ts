export type PageIndex = 0 | 1
export function pageFromSearch(search: string): PageIndex {
  return new URLSearchParams(search).get('page') === '2' ? 1 : 0
}
export function nextPage(page: PageIndex): PageIndex { return page === 0 ? 1 : 0 }
export function rotationDelay(search: string): number {
  const seconds = Number(new URLSearchParams(search).get('interval'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(60000, Math.max(3000, seconds * 1000)) : 3000
}
