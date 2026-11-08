/**
 * Bun appends a developer hint to fetch failures; users cannot act on it.
 */
const FETCH_VERBOSE_HINT = " For more information, pass `verbose: true` in the second argument to fetch()";

/** Drop Bun's `verbose: true` developer hint from a fetch failure message; keep the rest verbatim. */
export const withoutFetchVerboseHint = (message: string): string => message.replace(FETCH_VERBOSE_HINT, "");
