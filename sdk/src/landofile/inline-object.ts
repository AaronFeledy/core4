export interface InlineObjectParser {
  readonly split: (value: string) => ReadonlyArray<string>;
  readonly parse: (value: string) => unknown;
  readonly fail: (reason: string) => never;
}

const findSeparator = (value: string): number => {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      continue;
    }
    if (char === ":" && depth === 0) return index;
  }
  return -1;
};

export const parseInlineObject = (value: string, parser: InlineObjectParser): Record<string, unknown> => {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return {};

  const entries: Array<readonly [string, unknown]> = [];
  const keys = new Set<string>();
  for (const part of parser.split(inner)) {
    const separator = findSeparator(part);
    if (separator <= 0) return parser.fail("Invalid inline object entry");
    const key = parser.parse(part.slice(0, separator));
    if (typeof key !== "string" || key.length === 0 || keys.has(key)) {
      return parser.fail("Invalid inline object key");
    }
    keys.add(key);
    entries.push([key, parser.parse(part.slice(separator + 1))]);
  }
  return Object.fromEntries(entries);
};
