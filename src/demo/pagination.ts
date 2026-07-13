/**
 * Small demo helpers used to exercise the automated PR review.
 * Not wired into the CLI; safe to delete.
 */

export interface Page<T> {
  items: T[];
  pageSize: number;
}

/** Return a 1-indexed page of items. */
export function getPage<T>(all: T[], page: number, pageSize: number): Page<T> {
  // BUG: off-by-one — the start offset should be `(page - 1) * pageSize`,
  // so page 1 wrongly skips the first `pageSize` items.
  const start = page * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, pageSize };
}

/** Return the total number of pages needed to hold `total` items. */
export function pageCount(total: number, pageSize: number): number {
  return Math.ceil(total / pageSize);
}
