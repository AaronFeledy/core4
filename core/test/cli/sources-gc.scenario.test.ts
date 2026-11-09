import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type SourceGcReport, SourceGcReportSchema } from "@lando/source-acquisition/gc";
import {
  disposeTestSourceStore,
  makeTestSourceStore,
  withTestSession,
} from "@lando/source-acquisition/testing";
import { Effect, Schema } from "effect";
import { makeFakeArchive, makeTarGz, sha256Of } from "./_sources-gc-support.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const parseResult = (stdout: string): SourceGcReport => {
  const envelope = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean, result: SourceGcReportSchema })),
  )(stdout);
  expect(envelope.ok).toBe(true);
  return envelope.result;
};

describe("sources:gc CLI", () => {
  let cacheRoot: string | undefined;
  let fixture: Awaited<ReturnType<typeof makeTestSourceStore>> | undefined;

  afterEach(async () => {
    if (fixture !== undefined) {
      await disposeTestSourceStore(fixture);
      fixture = undefined;
    }
    if (cacheRoot !== undefined) {
      await rm(cacheRoot, { recursive: true, force: true });
      cacheRoot = undefined;
    }
  });

  test("report-only and prune --format=json against an isolated seeded cache", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-sources-gc-cwd-"));
    try {
      const archive = makeFakeArchive();
      const bytes = makeTarGz([{ name: "hello.txt", bytes: new TextEncoder().encode("hello\n") }]);
      const sha256 = sha256Of(bytes);
      const url = "https://example.test/hello.tgz";
      archive.set(url, bytes);

      fixture = await makeTestSourceStore({ archive: archive.transport });
      cacheRoot = dirname(fixture.root);

      await Effect.runPromise(
        withTestSession(fixture.store, (session) => session.acquireArchive({ url, sha256 })),
      );

      const entryJson = join(fixture.root, "archive", sha256, "entry.json");
      await utimes(entryJson, 1, 1);

      const env = {
        LANDO_USER_CACHE_ROOT: cacheRoot,
        LANDO_USER_DATA_ROOT: join(cacheRoot, "data"),
        LANDO_USER_CONF_ROOT: join(cacheRoot, "conf"),
      };

      const reportOnly = await runCli(
        ["sources:gc", "--older-than=0", "--format=json", "--renderer=plain"],
        cwd,
        env,
      );
      expect(reportOnly.exitCode, reportOnly.stderr + reportOnly.stdout).toBe(0);
      const report = parseResult(reportOnly.stdout);
      expect(report.prune).toBe(false);
      expect(report.totals.entries).toBe(1);
      expect(report.totals.eligible).toBe(1);
      expect(report.totals.removed).toBe(0);

      const pruned = await runCli(
        ["sources:gc", "--prune", "--older-than=0", "--format=json", "--renderer=plain", "--yes"],
        cwd,
        env,
      );
      expect(pruned.exitCode, pruned.stderr + pruned.stdout).toBe(0);
      const prunedReport = parseResult(pruned.stdout);
      expect(prunedReport.prune).toBe(true);
      expect(prunedReport.totals.removed).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects negative, fractional, and non-finite older-than values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-sources-gc-invalid-"));
    try {
      const env = {
        LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
        LANDO_USER_DATA_ROOT: join(cwd, "data"),
        LANDO_USER_CONF_ROOT: join(cwd, "conf"),
      };
      for (const { value, exitCode } of [
        { value: "-1", exitCode: 2 },
        { value: "1.5", exitCode: 2 },
        { value: "NaN", exitCode: 2 },
        { value: "Infinity", exitCode: 2 },
      ]) {
        const result = await runCli(["sources:gc", `--older-than=${value}`, "--format=json"], cwd, env);
        expect(result.exitCode, result.stderr + result.stdout).toBe(exitCode);
        const envelope = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              ok: Schema.Boolean,
              error: Schema.Struct({ _tag: Schema.String, flag: Schema.String }),
            }),
          ),
        )(result.stdout);
        expect(envelope).toMatchObject({
          ok: false,
          error: { _tag: "MalformedCliFlagValueError", flag: "older-than" },
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
