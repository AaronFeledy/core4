#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { loadLandofileLayers } from "@lando/landofile/service";
import { Effect, References, Schema, Tracer } from "effect";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../landofile/test/support.ts";

const repoRoot = resolve(import.meta.dirname, "..");
export const fixtureNames = ["one-layer", "three-layers", "six-layers", "fragment-heavy"] as const;
const TimingBaseline = Schema.Struct({
  medianMs: Schema.Number.check(Schema.isGreaterThan(0)),
  p95Ms: Schema.Number.check(Schema.isGreaterThan(0)),
});
const BaselineFile = Schema.Struct({
  landofileLoad: Schema.Struct({
    baseCommit: Schema.String,
    platform: Schema.String,
    runs: Schema.Int.check(Schema.isGreaterThan(0)),
    warmups: Schema.Literal(3),
    allowedRegressionPercent: Schema.Literal(25),
    fixtures: Schema.Struct({
      "one-layer": TimingBaseline,
      "three-layers": TimingBaseline,
      "six-layers": TimingBaseline,
      "fragment-heavy": TimingBaseline,
    }),
  }),
});
export const readBaseline = async (path: string) =>
  Schema.decodeUnknownSync(BaselineFile)(await Bun.file(path).json()).landofileLoad;

export const parseArgs = (argv: readonly string[]) => {
  let baselinePath = join(repoRoot, "scripts/bench-baselines.json");
  let runs = 30;
  let json = false;
  let fixture: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = (argv[index] ?? "").split("=", 2);
    const value = () => {
      const next = inline ?? argv[++index];
      if (next === undefined) throw new TypeError(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--json":
        json = true;
        break;
      case "--runs":
        runs = Number(value());
        if (!Number.isSafeInteger(runs) || runs < 1) throw new TypeError("--runs must be a positive integer");
        break;
      case "--baseline":
        baselinePath = resolve(value());
        break;
      case "--fixture":
        fixture = value();
        if (!fixtureNames.some((name) => name === fixture)) throw new TypeError(`Unknown fixture ${fixture}`);
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new TypeError(`Unknown option ${flag}`);
    }
  }
  return { baselinePath, runs, json, fixture, help };
};

const percentile = (sorted: readonly number[], fraction: number) => {
  const value = sorted[Math.ceil(sorted.length * fraction) - 1];
  if (value === undefined) throw new RangeError("Cannot summarize empty timings");
  return value;
};

export const runBenchmark = async (options: ReturnType<typeof parseArgs>) => {
  const baseline = await readBaseline(options.baselinePath);
  const root = await mkdtemp(join(tmpdir(), "lando-load-bench-"));
  try {
    const inputs: LandofileRuntimeInputs = {
      ports: makeTestLandofilePorts(join(root, "cache"), join(root, "includes")),
      stateStore: makeTestLandofileStateStore(),
      templates: { modules: [], context: { env: {}, scope: "app", bootstrapLevel: "plugins" } },
    };
    const fixtures = [];
    for (const name of fixtureNames.filter(
      (name) => options.fixture === undefined || options.fixture === name,
    )) {
      const appRoot = join(repoRoot, "scripts/fixtures/landofile-load", name);
      const load = loadLandofileLayers(appRoot, join(appRoot, ".lando.yml"), inputs).pipe(
        Effect.provideService(References.TracerEnabled, false),
      );
      for (let index = 0; index < baseline.warmups; index += 1) await Effect.runPromise(load);
      const timings = [];
      for (let index = 0; index < options.runs; index += 1) {
        const start = performance.now();
        await Effect.runPromise(load);
        timings.push(performance.now() - start);
      }
      timings.sort((left, right) => left - right);
      const middle = timings.slice(Math.floor((timings.length - 1) / 2), Math.floor(timings.length / 2) + 1);
      const medianMs = middle.reduce((sum, value) => sum + value, 0) / middle.length;
      const p95Ms = percentile(timings, 0.95);
      const spans: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      await Effect.runPromise(
        loadLandofileLayers(appRoot, join(appRoot, ".lando.yml"), inputs).pipe(
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(References.TracerEnabled, true),
        ),
      );
      const finalizations = spans.filter((name) => name === "Landofile.finalize").length;
      const layerDecodes = spans.filter((name) => name === "Landofile.decodeLayer").length;
      const prior = baseline.fixtures[name];
      const multiplier = 1 + baseline.allowedRegressionPercent / 100;
      fixtures.push({
        fixture: name,
        runs: options.runs,
        warmups: baseline.warmups,
        medianMs,
        p95Ms,
        finalizations,
        layerDecodes,
        baseline: prior,
        ok:
          medianMs <= prior.medianMs * multiplier &&
          p95Ms <= prior.p95Ms * multiplier &&
          finalizations === 1 &&
          layerDecodes === 0,
      });
    }
    return {
      ok: fixtures.every((fixture) => fixture.ok),
      platform: `${process.platform}-${process.arch}`,
      fixtures,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: bun run scripts/bench-landofile-load.ts [--json] [--runs=N] [--fixture <name>] [--baseline <path>]",
    );
  } else {
    const result = await runBenchmark(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `Landofile load benchmark ${result.ok ? "passed" : "failed"} (+25% median/p95 regression cap)`,
      );
      for (const fixture of result.fixtures) {
        console.log(
          `${fixture.fixture}: median ${fixture.medianMs.toFixed(3)}ms, p95 ${fixture.p95Ms.toFixed(3)}ms, finalizations: ${fixture.finalizations}, layer decodes: ${fixture.layerDecodes}`,
        );
      }
    }
    if (!result.ok) process.exitCode = 1;
  }
}
