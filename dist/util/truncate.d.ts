/**
 * Size caps for tool output.
 *
 * Truncation is always explicit: callers get a `truncated` flag and the original
 * size so an agent can decide to narrow its query rather than silently reasoning
 * over a clipped payload.
 */
/** Default cap for DOM/HTML and other large text payloads. */
export declare const DEFAULT_TEXT_CAP = 200000;
/** Default cap for serialized eval results. */
export declare const DEFAULT_RESULT_CAP = 100000;
export interface Truncated {
  text: string;
  truncated: boolean;
  /** Byte length of the original payload, present only when truncated. */
  originalLength?: number;
}
export declare function truncateText(text: string, cap?: number): Truncated;
/** Cap an array, reporting how many entries were dropped. */
export declare function truncateList<T>(
  items: T[],
  max: number,
): {
  items: T[];
  truncated: boolean;
  total: number;
};
