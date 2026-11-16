// allow: SIZE_OK — one seeded generator and its two property assertions share a single PRNG stream, so the fixture stays whole.
import { describe, expect, test } from "bun:test";
import { createLineStreamRedactor, createOutputLineRedactor } from "@lando/redaction/line-stream";
import { type Redactor, createRedactor } from "@lando/sdk/secrets";

/**
 * Seeded property tests for the bounded line-stream redactor.
 *
 * Each iteration embeds exactly one secret construct carrying a unique canary
 * in otherwise public output, delivers the bytes in random chunks, and asserts
 * the canary never reaches a released line. A second property proves that,
 * inside the documented exclusions (no escaped or same-quote-adjacent opener,
 * no registered multi-line value, LF line endings, every construct closed
 * within the hold bounds), releasing line by line is exactly whole-string
 * redaction.
 *
 * Everything draws from one mulberry32 stream per property, so a failure
 * reports the seed, the iteration, and the generated input that reproduced it.
 */

const encoder = new TextEncoder();

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
};

interface Rng {
  readonly int: (bound: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly chance: (probability: number) => boolean;
}

const makeRng = (seed: number): Rng => {
  const next = mulberry32(seed);
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("empty choice");
      return item;
    },
    chance: (probability: number) => next() < probability,
  };
};

const HEX_DIGITS = "0123456789abcdef";
const WORDS = [
  "step",
  "layer",
  "cache",
  "health",
  "digest",
  "prepare",
  "install",
  "compile",
  "probe",
  "fetch",
  "verify",
  "package",
  "bundle",
  "upload",
  "manifest",
  "network",
  "volume",
  "artifact",
  "runner",
  "queue",
] as const;
const UTF8_WORDS = [
  "caf\u00e9",
  "na\u00efve",
  "\u65e5\u672c\u8a9e",
  "\ud83d\ude80",
  "Gr\u00fc\u00dfe",
] as const;
const PREFIXES = ["", "log: ", "STEP 3/5: ", "12:00:01 ", "remote: "] as const;
const ASSIGNMENT_NAMES = [
  "password",
  "token",
  "api_key",
  "api-key",
  "apikey",
  "secret",
  "DB_PASSWORD",
  "client_secret",
  "access_token",
  "AUTH_TOKEN",
  "mysql_password",
  "credential_id",
] as const;
const QUERY_NAMES = [
  "token",
  "access_token",
  "api_key",
  "api-key",
  "signature",
  "sig",
  "secret",
  "X-Amz-Signature",
] as const;
const QUOTES = ['"', "'"] as const;
const CONSTRUCT_KINDS = [
  "assignment",
  "bearer",
  "query",
  "userinfo-before",
  "userinfo-consume",
  "registered",
] as const;

type ConstructKind = (typeof CONSTRUCT_KINDS)[number];
/** The differential profile excludes registered values, whose bytes the payload layer removes pre-framing. */
const DIFFERENTIAL_KINDS = CONSTRUCT_KINDS.filter((kind) => kind !== "registered");

const hex = (rng: Rng): string =>
  Array.from({ length: 8 }, () => HEX_DIGITS.charAt(rng.int(HEX_DIGITS.length))).join("");

const canaryFor = (iteration: number, rng: Rng): string => `ck${iteration}x${hex(rng)}`;

const fill = (rng: Rng, count: number): string =>
  Array.from({ length: count }, () => rng.pick(WORDS)).join(" ");

const valueLine = (rng: Rng, canary?: string): string => {
  const parts = [fill(rng, rng.int(3))];
  if (canary !== undefined) parts.push(canary);
  if (rng.chance(0.2)) parts.push(rng.pick(UTF8_WORDS));
  const text = parts.filter((part) => part.length > 0).join(" ");
  return text.length > 0 ? text : rng.pick(WORDS);
};

const publicLine = (rng: Rng, marker: string): string => {
  const words = [fill(rng, 1 + rng.int(3))];
  if (rng.chance(0.25)) words.push(rng.pick(UTF8_WORDS));
  return `${marker} ${words.filter((word) => word.length > 0).join(" ")}`;
};

interface QuotedSpec {
  readonly opener: string;
  readonly quote: string;
  readonly canary: string;
  readonly closed: boolean;
}

/** Quoted value on the opener, spanning 1..4 lines, closed only when asked. */
const quoted = (rng: Rng, spec: QuotedSpec): readonly string[] => {
  const count = 1 + rng.int(4);
  const canaryIndex = rng.int(count);
  const values = Array.from({ length: count }, (_, index) =>
    valueLine(rng, index === canaryIndex ? spec.canary : undefined),
  );
  const lines = [`${spec.opener}${values[0] ?? ""}`, ...values.slice(1)];
  if (!spec.closed) return lines;
  const last = lines.at(-1) ?? spec.opener;
  return [...lines.slice(0, -1), `${last}${spec.quote}`];
};

interface Construct {
  readonly kind: ConstructKind;
  readonly lines: readonly string[];
  readonly canary: string;
  readonly values: readonly string[];
  readonly closed: boolean;
}

const assignment = (rng: Rng, canary: string, closed: boolean): Construct => {
  const quote = rng.pick(QUOTES);
  const name = rng.pick(ASSIGNMENT_NAMES);
  return {
    kind: "assignment",
    lines: quoted(rng, { opener: `${rng.pick(PREFIXES)}${name}=${quote}`, quote, canary, closed }),
    canary,
    values: [],
    closed,
  };
};

const bearer = (rng: Rng, canary: string): Construct => {
  const blanks = Array.from({ length: rng.int(3) }, () => (rng.chance(0.5) ? "" : "   "));
  const suffix = rng.chance(0.5) ? ` ${rng.pick(WORDS)}` : "";
  return {
    kind: "bearer",
    lines: [`${rng.pick(PREFIXES)}Authorization: Bearer`, ...blanks, `${canary}${suffix}`],
    canary,
    values: [],
    closed: true,
  };
};

const query = (rng: Rng, canary: string, closed: boolean): Construct => {
  const quote = rng.pick(QUOTES);
  const name = rng.pick(QUERY_NAMES);
  const prefix = rng.pick(PREFIXES);
  const opener = rng.chance(0.5) ? `${prefix}?mode=1&${name}=${quote}` : `${prefix}?${name}=${quote}`;
  return { kind: "query", lines: quoted(rng, { opener, quote, canary, closed }), canary, values: [], closed };
};

/** A complete URL with userinfo before the quoted assignment on the same line. */
const userinfoBefore = (rng: Rng, canary: string, closed: boolean): Construct => {
  const name = rng.pick(ASSIGNMENT_NAMES);
  const opener = `${rng.pick(PREFIXES)}https://u${hex(rng)}:p${hex(rng)}@host${hex(rng)}.test ${name}="`;
  return {
    kind: "userinfo-before",
    lines: quoted(rng, { opener, quote: '"', canary, closed }),
    canary,
    values: [],
    closed,
  };
};

/** The URL userinfo's password ends on the assignment's quote, so it consumes that quote. */
const userinfoConsume = (rng: Rng, canary: string): Construct => {
  const name = rng.pick(ASSIGNMENT_NAMES);
  const count = 1 + rng.int(3);
  const canaryIndex = rng.int(count);
  const values = Array.from({ length: count }, (_, index) =>
    valueLine(rng, index === canaryIndex ? canary : undefined),
  );
  const first = `${rng.pick(PREFIXES)}${name}="https://u${hex(rng)}:p${hex(rng)}"@host${hex(rng)}.test`;
  return {
    kind: "userinfo-consume",
    lines: [first, ...values.slice(0, -1), `${values.at(-1) ?? ""}"`],
    canary,
    values: [],
    closed: true,
  };
};

/** A registered exact value whose bytes cross a newline; the canary is in both halves. */
const registered = (rng: Rng, canary: string): Construct => ({
  kind: "registered",
  lines: [`${rng.pick(PREFIXES)}before ${canary}_left`, `${canary}_right after`],
  canary,
  values: [`${canary}_left\n${canary}_right`],
  closed: true,
});

const chunkSizes = (rng: Rng): readonly number[] => {
  const mode = rng.int(3);
  if (mode === 0) return [1];
  if (mode === 1) return [2, 3, 5];
  return Array.from({ length: 6 }, () => 1 + rng.int(9));
};

interface GeneratedCase {
  readonly seed: number;
  readonly iteration: number;
  readonly kind: ConstructKind;
  readonly input: string;
  readonly canary: string;
  readonly values: readonly string[];
  readonly closed: boolean;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly heldLines: number;
  readonly heldBytes: number;
  readonly chunks: readonly number[];
}

/**
 * `bytes` is the leak profile: CRLF or LF, optional dangling assignment, and
 * registered values. `lines` is the differential profile: the documented
 * exclusions, so line-by-line release must equal whole-string redaction.
 */
interface CaseSpec {
  readonly seed: number;
  readonly iteration: number;
  readonly profile: "bytes" | "lines";
}

const generate = (rng: Rng, spec: CaseSpec): GeneratedCase => {
  const { iteration, profile } = spec;
  const canary = canaryFor(iteration, rng);
  const kinds: readonly ConstructKind[] = profile === "bytes" ? CONSTRUCT_KINDS : DIFFERENTIAL_KINDS;
  const kind = rng.pick(kinds);
  const closed = profile === "bytes" && kind === "assignment" ? rng.chance(0.75) : true;
  const eol = profile === "bytes" && rng.chance(0.5) ? "\r\n" : "\n";
  const built =
    kind === "assignment"
      ? assignment(rng, canary, closed)
      : kind === "bearer"
        ? bearer(rng, canary)
        : kind === "query"
          ? query(rng, canary, closed)
          : kind === "userinfo-before"
            ? userinfoBefore(rng, canary, closed)
            : kind === "userinfo-consume"
              ? userinfoConsume(rng, canary)
              : registered(rng, canary);
  // A registered value is literal bytes, so it carries the stream's own newline.
  const construct: Construct =
    built.kind === "registered"
      ? { ...built, values: built.values.map((value) => value.replaceAll("\n", eol)) }
      : built;
  const before = Array.from({ length: rng.int(4) }, (_, index) => publicLine(rng, `pb${iteration}_${index}`));
  const after = Array.from({ length: 1 + rng.int(2) }, (_, index) =>
    publicLine(rng, `pa${iteration}_${index}`),
  );
  const trailing = profile === "bytes" && rng.chance(0.5) ? eol : "";
  const input = [...before, ...construct.lines, ...after].join(eol) + trailing;
  const block = construct.closed ? construct.lines : [...construct.lines, ...after];
  const heldLines = block.length;
  const heldBytes =
    block.reduce((total, line) => total + encoder.encode(line).length, 0) + Math.max(0, heldLines - 1);
  return {
    seed: spec.seed,
    iteration,
    kind: construct.kind,
    input,
    canary: construct.canary,
    values: construct.values,
    closed: construct.closed,
    before,
    after,
    heldLines,
    heldBytes,
    chunks: chunkSizes(rng),
  };
};

interface Bounds {
  readonly maxHeldLines?: number;
  readonly maxHeldBytes?: number;
}

const chunksOf = (generated: GeneratedCase): ReadonlyArray<Uint8Array> => {
  const bytes = encoder.encode(generated.input);
  const slices: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; offset < bytes.length; index += 1) {
    const size = generated.chunks[index % generated.chunks.length] ?? 1;
    const next = Math.min(offset + size, bytes.length);
    slices.push(bytes.subarray(offset, next));
    offset = next;
  }
  return slices;
};

const runBytes = (generated: GeneratedCase, bounds: Bounds): readonly string[] => {
  const values = generated.values;
  const output = createOutputLineRedactor(
    { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
    bounds,
  );
  const released = chunksOf(generated).flatMap((chunk) => output.write(chunk));
  released.push(...output.end());
  return released;
};

/** Prove the delivered chunking actually splits multibyte characters and CRLF pairs. */
const splitAudit = (generated: GeneratedCase): { readonly multibyte: boolean; readonly crlf: boolean } => {
  const bytes = encoder.encode(generated.input);
  const boundaries = new Set<number>();
  let offset = 0;
  for (const chunk of chunksOf(generated)) {
    offset += chunk.length;
    boundaries.add(offset);
  }
  let multibyte = false;
  let crlf = false;
  for (let index = 1; index < bytes.length; index += 1) {
    if (!boundaries.has(index)) continue;
    if (((bytes[index] ?? 0) & 0xc0) === 0x80) multibyte = true;
    if (bytes[index - 1] === 0x0d && bytes[index] === 0x0a) crlf = true;
  }
  return { multibyte, crlf };
};

const runLines = (
  redactor: Pick<Redactor, "redactString">,
  lines: readonly string[],
  bounds: Bounds = {},
): readonly string[] => {
  const stream = createLineStreamRedactor(redactor, bounds);
  const released: string[] = [];
  for (const line of lines) released.push(...stream.push(line));
  released.push(...stream.flush());
  return released;
};

const failure = (generated: GeneratedCase, detail: string): string =>
  `${detail}\nseed=${generated.seed} iteration=${generated.iteration} kind=${generated.kind}\n` +
  `input=${JSON.stringify(generated.input)}\nvalues=${JSON.stringify(generated.values)}\n` +
  `chunks=${JSON.stringify(generated.chunks)}`;

const assertSafe = (released: readonly string[], generated: GeneratedCase, boundLabel: string): void => {
  const leakedAt = released.findIndex((line) => line.includes(generated.canary));
  if (leakedAt >= 0) {
    const leaked = JSON.stringify(released[leakedAt]);
    throw new Error(
      failure(generated, `canary leaked into released line ${leakedAt} ${leaked} (${boundLabel})`),
    );
  }
  const before = released.filter((line) => line.startsWith(`pb${generated.iteration}_`));
  if (
    before.length !== generated.before.length ||
    before.some((line, index) => line !== generated.before[index])
  ) {
    throw new Error(
      failure(
        generated,
        `public before lines changed or vanished (${boundLabel}): ${JSON.stringify(before)}`,
      ),
    );
  }
  if (!generated.closed) return;
  const after = released.filter((line) => line.startsWith(`pa${generated.iteration}_`));
  if (
    after.length !== generated.after.length ||
    after.some((line, index) => line !== generated.after[index])
  ) {
    throw new Error(
      failure(generated, `public after lines changed or vanished (${boundLabel}): ${JSON.stringify(after)}`),
    );
  }
};

describe("bounded line-stream redaction under seeded fuzzing", () => {
  test("never releases a canary from a multi-line secret construct", () => {
    const seed = 0x51d3_1eaf;
    const rng = makeRng(seed);
    const iterations = 240;
    const seen = new Set<ConstructKind>();
    let heldBeyondOneLine = 0;
    let registeredValues = 0;
    let multibyteSplits = 0;
    let crlfSplits = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      // Given one random construct with its own canary, plus public lines around it.
      const generated = generate(rng, { seed, iteration, profile: "bytes" });
      seen.add(generated.kind);
      heldBeyondOneLine += generated.heldLines > 1 ? 1 : 0;
      registeredValues += generated.values.length > 0 ? 1 : 0;
      const audit = splitAudit(generated);
      multibyteSplits += audit.multibyte ? 1 : 0;
      crlfSplits += audit.crlf ? 1 : 0;

      // When the bytes arrive in random chunks under the default bounds.
      assertSafe(runBytes(generated, {}), generated, "default bounds");

      // Then the same input fits exactly at explicit per-case bounds too.
      const exact = {
        maxHeldLines: Math.max(1, generated.heldLines),
        maxHeldBytes: Math.max(1, generated.heldBytes),
      };
      assertSafe(runBytes(generated, exact), generated, "exact bounds");
    }

    // The generator must actually cover every shape, the hold path, and both split kinds.
    const context = `seed=${seed} iterations=${iterations}`;
    expect(seen.size, context).toBe(CONSTRUCT_KINDS.length);
    expect(heldBeyondOneLine, context).toBeGreaterThan(0);
    expect(registeredValues, context).toBeGreaterThan(0);
    expect(multibyteSplits, context).toBeGreaterThan(0);
    expect(crlfSplits, context).toBeGreaterThan(0);
  });

  test("matches whole-string redaction when every construct closes within the bounds", () => {
    const seed = 0x2f6e_91c3;
    const rng = makeRng(seed);
    const iterations = 180;
    const seen = new Set<ConstructKind>();

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      // Given LF-only output with no excluded opener and no registered value.
      const generated = generate(rng, { seed, iteration, profile: "lines" });
      seen.add(generated.kind);
      const redactor = createRedactor("secrets", { values: [] });

      // When releasing the same input once per line (at the default and at exact
      // per-case bounds) and once through the byte pipeline.
      const lines = generated.input.split("\n");
      const direct = runLines(redactor, lines);
      const exact = {
        maxHeldLines: Math.max(1, generated.heldLines),
        maxHeldBytes: Math.max(1, generated.heldBytes),
      };
      const candidates: ReadonlyArray<readonly [string, readonly string[]]> = [
        ["default bounds", direct],
        ["exact bounds", runLines(redactor, lines, exact)],
        ["byte pipeline", runBytes(generated, {})],
      ];

      // Then every release is exactly whole-string redaction.
      const expected = redactor.redactString(generated.input);
      for (const [label, released] of candidates) {
        const text = released.join("\n");
        if (text !== expected) {
          throw new Error(
            failure(
              generated,
              `${label} differs from redactString:\nreleased=${JSON.stringify(text)}\nexpected=${JSON.stringify(expected)}`,
            ),
          );
        }
      }
      assertSafe(direct, generated, "differential");
    }

    expect(seen.size, `seed=${seed} iterations=${iterations}`).toBe(DIFFERENTIAL_KINDS.length);
  });
});
