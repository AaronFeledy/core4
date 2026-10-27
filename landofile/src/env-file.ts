type EnvFileParseIssue = {
  readonly source: string;
  readonly line: number;
  readonly message: string;
  readonly suggestion?: string;
};

export type EnvFileEntry = {
  readonly key: string;
  readonly value: string;
  readonly raw: string;
  readonly quote: '"' | "'" | undefined;
  readonly line: number;
};

export type EnvFileWarning = {
  readonly line: number;
  readonly key: string;
  readonly message: string;
  readonly suggestion: string;
};

type EnvFileParseResult =
  | {
      readonly ok: true;
      readonly environment: Readonly<Record<string, string>>;
      readonly entries: ReadonlyArray<EnvFileEntry>;
      readonly warnings: ReadonlyArray<EnvFileWarning>;
    }
  | { readonly ok: false; readonly issue: EnvFileParseIssue };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  $: "$",
  '"': '"',
  "\\": "\\",
};

const DECODED_ESCAPE_SUGGESTION =
  "Quote the value with single quotes to keep the raw text, or write \\\\ for each backslash you want to keep.";

const INTERPOLATION_SUGGESTION = "Use single quotes or environment: with {{ env.* }}.";

const isHorizontalWhitespace = (char: string): boolean =>
  char !== "\n" && char !== "\r" && char.trim() === "";

export const decodeDoubleQuotedEnvValue = (raw: string): string => {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    if (current !== "\\") {
      decoded += current;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) {
      decoded += "\\";
      break;
    }
    const mapped = DOUBLE_QUOTED_ESCAPES[next];
    if (mapped !== undefined) {
      decoded += mapped;
      index += 1;
      continue;
    }
    if (next === "0") {
      const digits = raw.slice(index + 2, index + 5);
      if (/^[0-7]{3}$/u.test(digits)) {
        const code = Number.parseInt(digits, 8);
        if (code <= 255) {
          decoded += String.fromCharCode(code);
          index += 4;
          continue;
        }
      }
    }
    decoded += `\\${next}`;
    index += 1;
  }
  return decoded;
};

const decodeSingleQuotedEnvValue = (raw: string): string => raw.replace(/\\'/gu, "'");

export const warningsForEnvFileEntry = (entry: EnvFileEntry): ReadonlyArray<EnvFileWarning> => {
  if (entry.quote === '"' && entry.value !== entry.raw) {
    return [
      {
        line: entry.line,
        key: entry.key,
        message: `Double-quoted value for ${entry.key} decodes differently from its raw text.`,
        suggestion: DECODED_ESCAPE_SUGGESTION,
      },
    ];
  }
  if (entry.quote !== "'" && (entry.raw.includes("${") || entry.value.includes("${"))) {
    return [
      {
        line: entry.line,
        key: entry.key,
        message: `Value for ${entry.key} contains \${, which env files do not interpolate.`,
        suggestion: INTERPOLATION_SUGGESTION,
      },
    ];
  }
  return [];
};

const findClosingQuote = (content: string, quote: '"' | "'", openingIndex: number): number => {
  for (let index = openingIndex + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\") {
      if (content[index + 1] === undefined) return -1;
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
};

const bareNameSuggestion = (name: string): string => `environment: { ${name}: "{{ env.${name} }}" }`;

export const parseEnvFile = (content: string, source: string): EnvFileParseResult => {
  const environment: Record<string, string> = {};
  const entries: EnvFileEntry[] = [];
  const warnings: EnvFileWarning[] = [];
  let index = 0;
  let line = 1;

  const consumeNewline = (): boolean => {
    if (content[index] === "\r" && content[index + 1] === "\n") {
      index += 2;
      line += 1;
      return true;
    }
    if (content[index] === "\n" || content[index] === "\r") {
      index += 1;
      line += 1;
      return true;
    }
    return false;
  };

  const skipHorizontalWhitespace = (): void => {
    while (index < content.length && isHorizontalWhitespace(content[index] ?? "")) {
      index += 1;
    }
  };

  const skipToLineEnd = (): void => {
    while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
      index += 1;
    }
  };

  while (index < content.length) {
    skipHorizontalWhitespace();
    if (index >= content.length) break;
    if (consumeNewline()) continue;
    if (content[index] === "#") {
      skipToLineEnd();
      continue;
    }

    const statementLine = line;
    const remaining = content.slice(index);
    const exportPrefix = remaining.match(/^export[ \t]+/u);
    if (exportPrefix?.[0] !== undefined) index += exportPrefix[0].length;

    const keyStart = index;
    while (
      index < content.length &&
      content[index] !== "=" &&
      content[index] !== "\n" &&
      content[index] !== "\r"
    ) {
      index += 1;
    }

    if (index >= content.length || content[index] !== "=") {
      const name = content.slice(keyStart, index).trim();
      return {
        ok: false,
        issue: {
          source,
          line: statementLine,
          message: "Expected KEY=VALUE.",
          ...(ENV_KEY.test(name) ? { suggestion: bareNameSuggestion(name) } : {}),
        },
      };
    }

    const key = content.slice(keyStart, index).trim();
    index += 1;
    skipHorizontalWhitespace();

    if (!ENV_KEY.test(key)) {
      return {
        ok: false,
        issue: {
          source,
          line: statementLine,
          message: `Invalid environment variable name ${JSON.stringify(key)}.`,
        },
      };
    }
    if (key === "__proto__") {
      return {
        ok: false,
        issue: {
          source,
          line: statementLine,
          message: 'The environment variable name "__proto__" is reserved.',
        },
      };
    }

    let raw: string;
    let value: string;
    let quote: '"' | "'" | undefined;
    const opener = content[index];
    if (opener === '"' || opener === "'") {
      quote = opener;
      const closingQuote = findClosingQuote(content, opener, index);
      if (closingQuote < 0) {
        return {
          ok: false,
          issue: {
            source,
            line: statementLine,
            message: "Quoted values must end with the matching quote.",
          },
        };
      }
      raw = content.slice(index + 1, closingQuote);
      for (const char of raw) {
        if (char === "\n") line += 1;
      }
      index = closingQuote + 1;
      const suffixStart = index;
      skipToLineEnd();
      const suffix = content.slice(suffixStart, index).trimStart();
      if (suffix.length > 0 && !suffix.startsWith("#")) {
        return {
          ok: false,
          issue: {
            source,
            line: statementLine,
            message: "Quoted values must end with the matching quote.",
          },
        };
      }
      value = opener === '"' ? decodeDoubleQuotedEnvValue(raw) : decodeSingleQuotedEnvValue(raw);
    } else {
      const valueStart = index;
      skipToLineEnd();
      const rawLine = content.slice(valueStart, index);
      const comment = rawLine.search(/[ \t]+#/u);
      raw = (comment < 0 ? rawLine : rawLine.slice(0, comment)).trimEnd();
      value = raw;
    }

    const entry: EnvFileEntry = { key, value, raw, quote, line: statementLine };
    environment[key] = value;
    entries.push(entry);
    warnings.push(...warningsForEnvFileEntry(entry));
    consumeNewline();
  }

  return { ok: true, environment, entries, warnings };
};
