/**
 * Size caps for tool output.
 *
 * Truncation is always explicit: callers get a `truncated` flag and the original
 * size so an agent can decide to narrow its query rather than silently reasoning
 * over a clipped payload.
 */
/** Default cap for DOM/HTML and other large text payloads. */
export const DEFAULT_TEXT_CAP = 200_000;
/** Default cap for serialized eval results. */
export const DEFAULT_RESULT_CAP = 100_000;
export function truncateText(text, cap = DEFAULT_TEXT_CAP) {
  if (text.length <= cap) return { text, truncated: false };
  const keep = Math.max(0, cap - 120);
  const omitted = text.length - keep;
  return {
    text: `${text.slice(0, keep)}\n\n[truncated: ${omitted} of ${text.length} characters omitted — narrow the query to see the rest]`,
    truncated: true,
    originalLength: text.length,
  };
}
/** Cap an array, reporting how many entries were dropped. */
export function truncateList(items, max) {
  if (items.length <= max) return { items, truncated: false, total: items.length };
  return { items: items.slice(0, max), truncated: true, total: items.length };
}
//# sourceMappingURL=truncate.js.map
