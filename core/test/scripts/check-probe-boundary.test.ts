import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkProbeBoundary } from "../../../scripts/check-probe-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-probe-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("probe boundary lint gate", () => {
  test("passes for runProbe usage, string repeat, Effect.sleep, and test fixtures", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/probe-consumer.ts",
        'import { runProbe } from "@lando/sdk/probe"; export const go = (spec, attempt) => runProbe(spec, attempt);\n',
      );
      await write(root, "core/src/x/string-repeat.ts", 'export const pad = (n: number) => " ".repeat(n);\n');
      await write(
        root,
        "core/src/x/sleep-loop.ts",
        'import { Effect } from "effect"; export const wait = Effect.sleep("5 millis");\n',
      );
      // A retry primitive inside a .test.ts file is ignored (tests are not scanned).
      await write(
        root,
        "core/src/x/loop.test.ts",
        'import { Effect, Schedule } from "effect"; const r = Effect.retry(eff, Schedule.exponential("1 second"));\n',
      );

      expect(await checkProbeBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports hand-rolled Effect.retry / Effect.repeat / Effect.schedule and Schedule uses", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/retry.ts",
        'import { Effect, Schedule } from "effect"; export const r = Effect.retry(eff, Schedule.exponential("1 second"));\n',
      );
      await write(
        root,
        "core/src/x/repeat.ts",
        'import { Effect } from "effect"; export const r = Effect.repeat(eff, { times: 3 });\n',
      );
      await write(
        root,
        "core/src/x/schedule.ts",
        'import { Effect } from "effect"; export const r = Effect.schedule(eff, sched);\n',
      );
      await write(
        root,
        "plugins/y/src/schedule-builder.ts",
        'import { Schedule } from "effect"; export const s = Schedule.recurs(3);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/x/repeat.ts:1:Effect.repeat",
        "core/src/x/retry.ts:1:Effect.retry",
        "core/src/x/retry.ts:1:Schedule.exponential",
        "core/src/x/schedule.ts:1:Effect.schedule",
        "plugins/y/src/schedule-builder.ts:1:Schedule.recurs",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports aliased Effect and Schedule imports", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/aliased-namespaces.ts",
        'import { Effect as Fx, Schedule as Sch } from "effect"; export const r = Fx.retry(eff, Sch.spaced("1 second"));\n',
      );
      await write(
        root,
        "core/src/x/direct-effect.ts",
        'import { retry as retryEffect } from "effect/Effect"; export const r = retryEffect(eff, sched);\n',
      );
      await write(
        root,
        "plugins/y/src/direct-schedule.ts",
        'import { recurs as repeatThree } from "effect/Schedule"; export const s = repeatThree(3);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/x/aliased-namespaces.ts:1:Effect.retry",
        "core/src/x/aliased-namespaces.ts:1:Schedule.spaced",
        "core/src/x/direct-effect.ts:1:Effect.retry",
        "plugins/y/src/direct-schedule.ts:1:Schedule.recurs",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allowlisted non-probe lock loops and named consumers are not flagged, but the same pattern elsewhere is", async () => {
    const root = await makeFixtureRoot();
    try {
      // Allowlisted pre-existing non-probe Schedule use stays clean.
      await write(
        root,
        "core/src/state/lock.ts",
        'import { Effect, Schedule } from "effect"; export const s = Effect.retry(eff, Schedule.spaced("10 millis"));\n',
      );
      // Same forbidden pattern at a non-allowlisted path IS flagged.
      await write(
        root,
        "core/src/elsewhere/loop.ts",
        'import { Effect, Schedule } from "effect"; export const s = Effect.retry(eff, Schedule.spaced("10 millis"));\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(result.offenders.map((offender) => relative(root, offender.file).replaceAll("\\", "/"))).toEqual(
        ["core/src/elsewhere/loop.ts", "core/src/elsewhere/loop.ts"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
