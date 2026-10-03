// The approvals queue remembers the order each person last chose.
//
// A cookie rather than localStorage because the order decides which rows the
// SERVER fetches (the oldest hundred are not the newest hundred re-sorted), and
// only a cookie reaches the server on a plain visit from the nav. It holds a
// display preference and nothing else; the page accepts only the two values.

export const APPROVALS_SORT_COOKIE = "approvals_sort";

export function rememberSort(sort: "newest" | "oldest") {
  try {
    document.cookie = `${APPROVALS_SORT_COOKIE}=${sort}; path=/dashboard/approvals; max-age=31536000; samesite=lax`;
  } catch {
    // A browser refusing cookies keeps the URL behaviour: this visit is
    // ordered as chosen, the next starts newest first.
  }
}
