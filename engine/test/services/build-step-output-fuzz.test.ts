// allow: SIZE_OK — one seeded generator and the recorder assertions share a single PRNG stream, so the fixture stays whole.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { Effect } from "effect";
import type { BuildRedaction } from "../../src/services/build-redaction.ts";
import { openBuildStepOutput } from "../../src/services/build-step-output.ts";

/**
 * Seeded property test for the build-step output recorder.
 *
 * Each iteration interleaves random stdout and stderr chunks carrying one
 * secret construct with a unique canary and public marker lines around it. The
 * canary must never reach the transcript, a published `task.detail` line, or
 * the bounded tail, and every marker must keep its own stream's order.
 */

const encoder = new TextEncoder();

/** Deterministic PRNG (mulberry32); the seed and iteration reproduce a failure. */
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
  "digest",
  "install",
  "compile",
  "fetch",
  "package",
  "bundle",
] as const;
const UTF8_WORDS = ["caf\u00e9", "\u65e5\u672c\u8a9e", "\ud83d\ude80"] as const;
const PREFIXES = ["", "log: ", "STEP 3/5: ", "remote: "] as const;
const ASSIGNMENT_NAMES = ["password", "token", "api_key", "secret", "DB_PASSWORD", "access_token"] as const;
const QUERY_NAMES = ["token", "api_key", "signature", "X-Amz-Signature"] as const;
const QUOTES = ['"', "'"] as const;
const KINDS = ["assignment", "bearer", "query", "registered"] as const;

type Kind = (typeof KINDS)[number];
type Stream = "stdout" | "stderr";

const hex = (rng: Rng): string =>
  Array.from({ length: 8 }, () => HEX_DIGITS.charAt(rng.int(HEX_DIGITS.length))).join("");

const fill = (rng: Rng, count: number): string =>
  Array.from({ length: count }, () => rng.pick(WORDS)).join(" ");

const valueLine = (rng: Rng, canary?: string): string => {
  const parts = [fill(rng, rng.int(3))];
  if (canary !== undefined) parts.push(canary);
  if (rng.chance(0.2)) parts.push(rng.pick(UTF8_WORDS));
  const text = parts.filter((part) => part.length > 0).join(" ");
  return text.length > 0 ? text : rng.pick(WORDS);
};

interface Construct {
  readonly kind: Kind;
  readonly lines: readonly string[];
  readonly canary: string;
  readonly values: readonly string[];
}

/** A quoted assignment whose value spans 2..4 lines. */
const assignment = (rng: Rng, canary: string): Construct => {
  const quote = rng.pick(QUOTES);
  const count = 2 + rng.int(3);
  const canaryIndex = rng.int(count);
  const values = Array.from({ length: count }, (_, index) =>
    valueLine(rng, index === canaryIndex ? canary : undefined),
  );
  return {
    kind: "assignment",
    lines: [
      `${rng.pick(PREFIXES)}${rng.pick(ASSIGNMENT_NAMES)}=${quote}${values[0] ?? ""}`,
      ...values.slice(1, -1),
      `${values.at(-1) ?? ""}${quote}`,
    ],
    canary,
    values: [],
  };
};

/** `Bearer` ending a line, blank lines, then the token on its own line. */
const bearer = (rng: Rng, canary: string): Construct => ({
  kind: "bearer",
  lines: [
    `${rng.pick(PREFIXES)}Authorization: Bearer`,
    ...Array.from({ length: rng.int(3) }, () => (rng.chance(0.5) ? "" : "   ")),
    canary,
  ],
  canary,
  values: [],
});

/** A signed query parameter whose quoted value spans 2..4 lines. */
const query = (rng: Rng, canary: string): Construct => {
  const quote = rng.pick(QUOTES);
  const count = 2 + rng.int(3);
  const canaryIndex = rng.int(count);
  const values = Array.from({ length: count }, (_, index) =>
    valueLine(rng, index === canaryIndex ? canary : undefined),
  );
  return {
    kind: "query",
    lines: [
      `${rng.pick(PREFIXES)}?${rng.pick(QUERY_NAMES)}=${quote}${values[0] ?? ""}`,
      ...values.slice(1, -1),
      `${values.at(-1) ?? ""}${quote}`,
    ],
    canary,
    values: [],
  };
};

/** A registered exact value whose bytes cross a newline; the canary is in both halves. */
const registered = (rng: Rng, canary: string): Construct => ({
  kind: "registered",
  lines: [`${rng.pick(PREFIXES)}before ${canary}_left`, `${canary}_right after`],
  canary,
  values: [`${canary}_left\n${canary}_right`],
});

interface StreamPlan {
  readonly text: string;
  readonly markers: readonly string[];
}

interface StreamSpec {
  readonly iteration: number;
  readonly stream: Stream;
  readonly construct: Construct | undefined;
  readonly eol: string;
}

const planStream = (rng: Rng, spec: StreamSpec): StreamPlan => {
  const { iteration, stream } = spec;
  const tag = stream === "stdout" ? "out" : "err";
  const markers = [
    `${tag}m${iteration}a ${fill(rng, 1 + rng.int(2))}`,
    `${tag}m${iteration}b ${fill(rng, 1 + rng.int(2))}`,
  ];
  const lines = [markers[0] ?? ""];
  if (spec.construct !== undefined) lines.push(...spec.construct.lines);
  lines.push(markers[1] ?? "");
  if (rng.chance(0.4)) lines.push(`${tag}p${iteration} ${rng.pick([...WORDS, ...UTF8_WORDS])}`);
  return { text: lines.join(spec.eol) + (rng.chance(0.5) ? spec.eol : ""), markers };
};

/** Interleave: draw from either stream that still has bytes, never one that is spent. */
const pickStream = (rng: Rng, remaining: Readonly<Record<Stream, number>>): Stream => {
  if (remaining.stdout === 0) return "stderr";
  if (remaining.stderr === 0) return "stdout";
  return rng.chance(0.5) ? "stdout" : "stderr";
};

const withTempRoots = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-build-step-output-fuzz-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeRedaction = (values: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const service = makeRedactionService();
    yield* service.registerValues(values);
    const options = { sourceEnv: {} };
    return {
      redactor: yield* service.forProfile("secrets", options),
      payloadValues: yield* service.payloadValues(options),
    } satisfies BuildRedaction;
  });

const makePublisher = () => {
  const published: LandoEvent[] = [];
  return {
    published,
    events: {
      publish: (event: LandoEvent) =>
        Effect.sync(() => {
          published.push(event);
        }),
    },
  };
};

const transcriptFor = (root: string, name: string) =>
  AbsolutePath.make(join(root, "builds", "app", "web", `${name}.log`));

interface Iteration {
  readonly seed: number;
  readonly iteration: number;
  readonly kind: Kind;
  readonly canary: string;
  readonly values: readonly string[];
  readonly stdout: StreamPlan;
  readonly stderr: StreamPlan;
}

const plan = (rng: Rng, seed: number, iteration: number): Iteration => {
  const canary = `ck${iteration}x${hex(rng)}`;
  const kind = rng.pick(KINDS);
  const eol = rng.chance(0.5) ? "\r\n" : "\n";
  const built =
    kind === "assignment"
      ? assignment(rng, canary)
      : kind === "bearer"
        ? bearer(rng, canary)
        : kind === "query"
          ? query(rng, canary)
          : registered(rng, canary);
  // A registered value is literal bytes, so it carries the stream's own newline.
  const construct: Construct =
    built.kind === "registered"
      ? { ...built, values: built.values.map((value) => value.replaceAll("\n", eol)) }
      : built;
  const constructStream = rng.chance(0.5) ? "stdout" : "stderr";
  return {
    seed,
    iteration,
    kind: construct.kind,
    canary,
    values: construct.values,
    stdout: planStream(rng, {
      iteration,
      stream: "stdout",
      construct: constructStream === "stdout" ? construct : undefined,
      eol,
    }),
    stderr: planStream(rng, {
      iteration,
      stream: "stderr",
      construct: constructStream === "stderr" ? construct : undefined,
      eol,
    }),
  };
};

const failure = (planned: Iteration, detail: string): string =>
  `${detail}\nseed=${planned.seed} iteration=${planned.iteration} kind=${planned.kind} canary=${planned.canary}\n` +
  `stdout=${JSON.stringify(planned.stdout.text)}\nstderr=${JSON.stringify(planned.stderr.text)}`;

const assertNoCanary = (text: string | undefined, where: string, planned: Iteration): void => {
  if (text === undefined || !text.includes(planned.canary)) return;
  const line = text.split("\n").find((candidate) => candidate.includes(planned.canary)) ?? text;
  throw new Error(failure(planned, `canary leaked into ${where}: ${JSON.stringify(line)}`));
};

describe("openBuildStepOutput under seeded fuzzing", () => {
  test("keeps a multi-line canary out of transcript, events, and tail", async () => {
    await withTempRoots(async (root) => {
      const seed = 0x7b3d_1c9f;
      const rng = makeRng(seed);
      const iterations = 24;
      const seen = new Set<Kind>();

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        // Given one construct split over a random stream's lines, with public markers around it.
        const planned = plan(rng, seed, iteration);
        seen.add(planned.kind);
        const publisher = makePublisher();
        const redaction = await Effect.runPromise(makeRedaction(planned.values));
        const transcriptPath = transcriptFor(root, `fuzz-${iteration}`);
        let tail: string | undefined;

        // When the two streams arrive in interleaved random chunks, then end.
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const recorder = yield* openBuildStepOutput({
                events: publisher.events,
                taskId: "web:app:install",
                transcriptPath,
                providerId: "test",
                userDataRoot: root,
                redaction,
              });
              const buffers = {
                stdout: encoder.encode(planned.stdout.text),
                stderr: encoder.encode(planned.stderr.text),
              };
              const offsets = { stdout: 0, stderr: 0 };
              while (offsets.stdout < buffers.stdout.length || offsets.stderr < buffers.stderr.length) {
                const stream = pickStream(rng, {
                  stdout: buffers.stdout.length - offsets.stdout,
                  stderr: buffers.stderr.length - offsets.stderr,
                });
                const start = offsets[stream];
                const end = Math.min(start + 1 + rng.int(9), buffers[stream].length);
                yield* recorder.write(stream, buffers[stream].subarray(start, end));
                offsets[stream] = end;
              }
              yield* recorder.end;
              tail = recorder.tail();
            }),
          ),
        );

        // Then the canary never surfaced, and every marker kept its stream's order.
        const transcript: string = await readFile(transcriptPath, "utf8");
        const transcriptLines = transcript.split("\n");
        if (transcriptLines.at(-1) === "") transcriptLines.pop();
        assertNoCanary(transcript, "the transcript", planned);
        assertNoCanary(tail, "the tail", planned);
        const detailLines = publisher.published.filter((event) => event._tag === "task.detail");
        expect(
          detailLines.map((event) => event.line),
          failure(planned, "detail events must deliver every transcript line"),
        ).toEqual(transcriptLines);
        expect(tail, failure(planned, "the short transcript must be retained in the tail")).toBe(
          transcriptLines.join("\n"),
        );
        assertNoCanary(
          detailLines.map((event) => (typeof event.line === "string" ? event.line : "")).join("\n"),
          "a published task.detail line",
          planned,
        );
        for (const name of ["stdout", "stderr"] as const) {
          const stream = planned[name];
          expect(
            detailLines
              .filter(
                (event) =>
                  event.stream === name &&
                  typeof event.line === "string" &&
                  stream.markers.includes(event.line),
              )
              .map((event) => event.line),
            failure(planned, `${name} detail markers must retain their stream and order`),
          ).toEqual([...stream.markers]);
          const seen = transcriptLines.filter((line) => stream.markers.includes(line));
          if (
            seen.length !== stream.markers.length ||
            seen.some((line, index) => line !== stream.markers[index])
          ) {
            throw new Error(
              failure(
                planned,
                `public marker lines changed or reordered: ${JSON.stringify(seen)} !== ${JSON.stringify(stream.markers)}`,
              ),
            );
          }
        }
      }

      // The generator must cover every shape, including the registered-value payload path.
      expect(seen.size, `seed=${seed} iterations=${iterations}`).toBe(KINDS.length);
    });
  });
});
