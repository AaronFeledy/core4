import { Effect } from "effect";

export const parseJsonOrUndefined = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const tryParseJson = <E>(text: string, onError: (cause: unknown) => E): Effect.Effect<unknown, E> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: onError });

export const parseNdjsonLines = (
  body: string,
  options: { readonly separator: "\n" | RegExp; readonly onInvalidLine: "skip" | "rethrow-non-syntax" },
): ReadonlyArray<unknown> => {
  const values: unknown[] = [];
  for (const line of body.split(options.separator)) {
    if (line.trim().length === 0) continue;
    switch (options.onInvalidLine) {
      case "skip": {
        const value = parseJsonOrUndefined(line);
        if (value !== undefined) values.push(value);
        break;
      }
      case "rethrow-non-syntax":
        try {
          values.push(JSON.parse(line));
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
        }
        break;
      default: {
        const exhaustive: never = options.onInvalidLine;
        return exhaustive;
      }
    }
  }
  return values;
};

export const encodeEngineFilters = (filters: Readonly<Record<string, ReadonlyArray<string>>>): string =>
  encodeURIComponent(JSON.stringify(filters));
