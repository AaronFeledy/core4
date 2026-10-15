/** Recognize plain mapping values for pure Landofile projection and merging. */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
