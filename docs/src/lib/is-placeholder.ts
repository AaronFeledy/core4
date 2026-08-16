/**
 * Detect placeholder transcript values that should not be shown as captured output.
 *
 * Public transcripts contain structure-only placeholders like "expected exit 0"
 * rather than real command output. This function identifies those placeholders
 * so the docs site can skip rendering empty "Captured output" sections.
 */
export const isPlaceholderResultSummary = (resultSummary: string | undefined): boolean => {
  if (resultSummary === undefined) return true;

  const trimmed = resultSummary.trim();
  if (trimmed === "") return true;

  // Match common placeholder patterns from generated public transcripts
  const placeholderPatterns = [
    /^expected exit \d+$/i, // "expected exit 0", "expected exit 1"
    /^event ".*" observed$/i, // 'event "post-start" observed'
    /^command ".*" succeeds$/i, // 'command "lando start" succeeds'
    /^error tag ".*" observed$/i, // 'error tag "NotImplementedError" observed'
    /^command output$/i, // "command output" (from Inspect with output prop)
    /^event stream$/i, // "event stream" (from Inspect with events prop)
    /^shell command$/i, // "shell command" (from Run with shell prop)
    /^file ".*" matches expectation$/i, // 'file "..." matches expectation' (from Verify with file prop)
  ];

  return placeholderPatterns.some((pattern) => pattern.test(trimmed));
};
