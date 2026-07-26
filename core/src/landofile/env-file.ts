type EnvFileParseIssue = {
  readonly source: string;
  readonly line: number;
  readonly message: string;
};

type EnvFileParseResult =
  | { readonly ok: true; readonly environment: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issue: EnvFileParseIssue };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const parseEnvFile = (content: string, source: string): EnvFileParseResult => {
  const environment: Record<string, string> = {};
  const lines = content.split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const entry = line.replace(/^export[ \t]+/u, "");
    const separator = entry.indexOf("=");
    if (separator < 0) {
      return {
        ok: false,
        issue: { source, line: index + 1, message: "Expected KEY=VALUE." },
      };
    }

    const key = entry.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) {
      return {
        ok: false,
        issue: {
          source,
          line: index + 1,
          message: `Invalid environment variable name ${JSON.stringify(key)}.`,
        },
      };
    }
    if (key === "__proto__") {
      return {
        ok: false,
        issue: {
          source,
          line: index + 1,
          message: 'The environment variable name "__proto__" is reserved.',
        },
      };
    }

    const rawValue = entry.slice(separator + 1).trim();
    const quote = rawValue[0];
    if (quote === '"' || quote === "'") {
      const closingQuote = rawValue.lastIndexOf(quote);
      const suffix = closingQuote < 1 ? rawValue : rawValue.slice(closingQuote + 1).trimStart();
      if (closingQuote < 1 || (suffix.length > 0 && !suffix.startsWith("#"))) {
        return {
          ok: false,
          issue: {
            source,
            line: index + 1,
            message: "Quoted values must end with the matching quote.",
          },
        };
      }
      environment[key] = rawValue.slice(1, closingQuote);
      continue;
    }
    const comment = rawValue.search(/[ \t]+#/u);
    environment[key] = comment < 0 ? rawValue : rawValue.slice(0, comment).trimEnd();
  }
  return { ok: true, environment };
};
