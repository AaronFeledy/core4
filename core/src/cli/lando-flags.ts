/**
 * Lando's own dispatcher flags: the one table every reader of argv shares.
 *
 * This module has no imports (not even type imports) because the compiled CLI
 * entry, `core/bin/lando.ts`, imports it statically on the cold path. A new
 * Lando flag is one row here plus the handler that acts on it.
 */

export type LandoFlagArity =
  /** Exact bare spelling only; `--verbose=true` is not Lando's. */
  | "none"
  /** `--name=value`, or `--name` plus the adjacent token unless that token is missing or starts with `-`. */
  | "value"
  /** Bare, `=fields`, or bare plus the adjacent token when it is a field list. */
  | "json"
  /** Reserved task-tree flag: bare or `=value`. */
  | "reserved"
  /** `--tail`: bare only when the adjacent token is missing or starts with `-`; never `--tail=N`. */
  | "reserved-tail";

export interface LandoFlag {
  readonly spelling: string;
  readonly arity: LandoFlagArity;
  readonly role: "selection" | "help" | "version" | "reserved";
  /** Result-encoding flag. */
  readonly output?: true;
  /** Label in the help footer; absent = not listed. */
  readonly footer?: string;
  /** Disables the cold fast paths in `core/bin/lando.ts`. */
  readonly diagnostic?: true;
}

export const LANDO_FLAGS = [
  { spelling: "--format", arity: "value", role: "selection", output: true, footer: "--format" },
  { spelling: "--json", arity: "json", role: "selection", output: true, footer: "--json [fields]" },
  { spelling: "-j", arity: "none", role: "selection", output: true },
  { spelling: "--jq", arity: "value", role: "selection", output: true, footer: "--jq" },
  { spelling: "--renderer", arity: "value", role: "selection", footer: "--renderer" },
  { spelling: "--verbose", arity: "none", role: "selection", footer: "--verbose", diagnostic: true },
  { spelling: "--log-level", arity: "value", role: "selection", footer: "--log-level", diagnostic: true },
  { spelling: "--debug", arity: "none", role: "selection", footer: "--debug", diagnostic: true },
  { spelling: "--trace", arity: "none", role: "selection", footer: "--trace" },
  { spelling: "--no-deprecation-warnings", arity: "none", role: "selection" },
  { spelling: "--help", arity: "none", role: "help" },
  { spelling: "-h", arity: "none", role: "help" },
  { spelling: "--version", arity: "none", role: "version" },
  { spelling: "-v", arity: "none", role: "version" },
  { spelling: "--expand", arity: "reserved", role: "reserved" },
  { spelling: "--no-expand", arity: "reserved", role: "reserved" },
  { spelling: "--collapse", arity: "reserved", role: "reserved" },
  { spelling: "--no-collapse", arity: "reserved", role: "reserved" },
  { spelling: "--tail", arity: "reserved-tail", role: "reserved" },
  { spelling: "--no-tail", arity: "reserved", role: "reserved" },
] as const satisfies ReadonlyArray<LandoFlag>;

export type LandoFlagSpelling = (typeof LANDO_FLAGS)[number]["spelling"];
export type LandoFlagEntry = LandoFlag & { readonly spelling: LandoFlagSpelling };

/** The output spellings a built-in or plugin definition can never claim. */
export const RESERVED_OUTPUT_SPELLINGS: ReadonlyArray<LandoFlagSpelling> = ["--format", "--json", "-j"];

const LANDO_FLAGS_BY_SPELLING: ReadonlyMap<string, LandoFlagEntry> = new Map<string, LandoFlagEntry>(
  LANDO_FLAGS.map((flag) => [flag.spelling, flag]),
);

// Equals form `--json=echo` is always a field list. Space form `--json <token>`
// is consumed only when the token matches this pattern AND contains `,` or `.`.
// A single bare identifier (`echo`) stays positional so `lando exec --json echo`
// does not steal the command; use `--json=app` for a one-key projection.
export const JSON_FIELD_LIST = /^[A-Za-z_][\w.-]*(,[A-Za-z_][\w.-]*)*$/;

export const isSpaceFormJsonFieldList = (token: string): boolean =>
  !token.startsWith("-") && JSON_FIELD_LIST.test(token) && (token.includes(",") || token.includes("."));

export interface LandoFlagMatch {
  readonly flag: LandoFlagEntry;
  /** The value typed with the flag: the `=` part (may be empty) or the adjacent token. */
  readonly value?: string;
  /** Whether the value came from `=` (true) or from the adjacent token (false). */
  readonly attached: boolean;
  /** Following tokens the flag consumed. */
  readonly consumed: 0 | 1;
}

/**
 * Match one token against the table. Returns `undefined` for every token the
 * extractors would not consume, including `--verbose=true`, `--tail=5`, and
 * `--tail 5`.
 */
export const matchLandoFlag = (token: string, next: string | undefined): LandoFlagMatch | undefined => {
  const exact = LANDO_FLAGS_BY_SPELLING.get(token);
  if (exact !== undefined) {
    const { arity } = exact;
    switch (arity) {
      case "none":
      case "reserved":
        return { flag: exact, attached: false, consumed: 0 };
      case "value":
        return next !== undefined && !next.startsWith("-")
          ? { flag: exact, value: next, attached: false, consumed: 1 }
          : { flag: exact, attached: false, consumed: 0 };
      case "json":
        return next !== undefined && isSpaceFormJsonFieldList(next)
          ? { flag: exact, value: next, attached: false, consumed: 1 }
          : { flag: exact, attached: false, consumed: 0 };
      case "reserved-tail":
        return next === undefined || next.startsWith("-")
          ? { flag: exact, attached: false, consumed: 0 }
          : undefined;
      default:
        return arity satisfies never;
    }
  }

  const equalsIndex = token.indexOf("=");
  if (equalsIndex <= 0) return undefined;
  const flag = LANDO_FLAGS_BY_SPELLING.get(token.slice(0, equalsIndex));
  if (flag === undefined) return undefined;
  const { arity } = flag;
  switch (arity) {
    case "none":
    case "reserved-tail":
      return undefined;
    case "value":
    case "json":
    case "reserved":
      return { flag, value: token.slice(equalsIndex + 1), attached: true, consumed: 0 };
    default:
      return arity satisfies never;
  }
};

const failedMatches = new WeakMap<object, LandoFlagMatch>();

const isWeakKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** The flag occurrence whose handler raised `error`, when it came from `scanLandoFlags`. */
export const failedLandoFlag = (error: unknown): LandoFlagMatch | undefined =>
  isWeakKey(error) ? failedMatches.get(error) : undefined;

/**
 * Walk `argv` up to the first `--`. Each token that matches a table flag with a
 * handler is passed to the handler and dropped (with its consumed value); every
 * other token is returned in order. When a handler throws, the match is
 * recorded against the thrown error and the error is rethrown.
 */
export const scanLandoFlags = (
  argv: ReadonlyArray<string>,
  handlers: Readonly<Partial<Record<LandoFlagSpelling, (match: LandoFlagMatch) => void>>>,
): string[] => {
  const remaining: string[] = [];
  let afterTerminator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") afterTerminator = true;
    if (afterTerminator) {
      remaining.push(token);
      continue;
    }
    const match = matchLandoFlag(token, argv[index + 1]);
    const handler = match === undefined ? undefined : handlers[match.flag.spelling];
    if (match === undefined || handler === undefined) {
      remaining.push(token);
      continue;
    }
    try {
      handler(match);
    } catch (error) {
      if (isWeakKey(error)) failedMatches.set(error, match);
      throw error;
    }
    index += match.consumed;
  }
  return remaining;
};

export const hasDiagnosticFlag = (tokens: ReadonlyArray<string>): boolean =>
  tokens.some((token) => matchLandoFlag(token, undefined)?.flag.diagnostic === true);

export const landoFlagFooterLabels = (): ReadonlyArray<string> => {
  const flags: ReadonlyArray<LandoFlag> = LANDO_FLAGS;
  return flags.flatMap((flag) => (flag.footer === undefined ? [] : [flag.footer]));
};
