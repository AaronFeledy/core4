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

  test("reports destructured Effect.retry and Schedule members", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/destructure-effect.ts",
        'import { Effect } from "effect"; const { retry } = Effect; export const r = retry(eff, sched);\n',
      );
      await write(
        root,
        "core/src/x/destructure-schedule.ts",
        'import { Schedule } from "effect"; const { recurs } = Schedule; export const s = recurs(3);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/x/destructure-effect.ts:1:Effect.retry",
        "core/src/x/destructure-schedule.ts:1:Schedule.recurs",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports export star barrel re-exports of forbidden bindings", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/x/inner.ts", 'export { retry } from "effect/Effect";\n');
      await write(root, "core/src/x/star-barrel.ts", 'export * from "./inner";\n');
      await write(
        root,
        "core/src/x/star-consumer.ts",
        'import { retry } from "./star-barrel"; export const r = retry(eff, sched);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["core/src/x/star-consumer.ts:1:Effect.retry"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports barrel re-exports and Effect.Schedule chained access", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/x/barrel.ts", 'export { retry as retryViaBarrel } from "effect/Effect";\n');
      await write(
        root,
        "core/src/x/consumer.ts",
        'import { retryViaBarrel } from "./barrel"; export const r = retryViaBarrel(eff, sched);\n',
      );
      await write(
        root,
        "core/src/x/chained-schedule.ts",
        'import { Effect } from "effect"; export const s = Effect.Schedule.recurs(3);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/x/chained-schedule.ts:1:Schedule.recurs",
        "core/src/x/consumer.ts:1:Effect.retry",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports destructuring in switch case and for-loop initializer", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/switch-case.ts",
        'import { Effect } from "effect"; export const f = (x: number) => { switch (x) { case 1: const { retry } = Effect; return retry(eff, sched); default: return eff; } };\n',
      );
      await write(
        root,
        "core/src/x/for-loop.ts",
        'import { Schedule } from "effect"; export const g = () => { for (const { recurs } = Schedule; false;) recurs(1); return 0; };\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["core/src/x/for-loop.ts:1:Schedule.recurs", "core/src/x/switch-case.ts:1:Effect.retry"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves barrel re-exports after fixpoint module analysis when the barrel is analyzed before its dependency", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/order-barrel.ts",
        'export { retry as retryViaBarrel } from "./order-inner";\n',
      );
      await write(root, "core/src/x/order-inner.ts", 'export { retry } from "effect/Effect";\n');
      await write(
        root,
        "core/src/x/order-consumer.ts",
        'import { retryViaBarrel } from "./order-barrel"; export const r = retryViaBarrel(eff, sched);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["core/src/x/order-consumer.ts:1:Effect.retry"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports forbidden calls through circular relative re-exports after fixpoint analysis", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/cycle-a.ts",
        'export { retry } from "effect/Effect";\nexport { retry as viaB } from "./cycle-b";\n',
      );
      await write(root, "core/src/x/cycle-b.ts", 'export { retry } from "./cycle-a";\n');
      await write(
        root,
        "core/src/x/cycle-consumer.ts",
        'import { viaB } from "./cycle-a"; export const r = viaB(eff, sched);\n',
      );

      const result = await checkProbeBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["core/src/x/cycle-consumer.ts:1:Effect.retry"]);
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
