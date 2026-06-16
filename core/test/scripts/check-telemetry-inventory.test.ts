import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkTelemetryInventory } from "../../../scripts/check-telemetry-inventory.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-telemetry-inventory-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("telemetry inventory gate", () => {
  test("passes when only inventory events are recorded", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/telemetry/events.ts",
        'export const r = (telemetry) => telemetry.record("update-outcome", {});\n',
      );
      await write(
        root,
        "core/src/deprecation/telemetry.ts",
        'export const d = (telemetry) => telemetry.record("deprecation-used", {});\n',
      );

      expect(await checkTelemetryInventory({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flags an event not present in the inventory", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/feature/bad.ts",
        'export const bad = (telemetry) => telemetry.record("totally-unknown", { a: 1 });\n',
      );
      await write(
        root,
        "plugins/example/src/index.ts",
        'export const p = (telemetry) => telemetry.record("plugin-event", {});\n',
      );

      const result = await checkTelemetryInventory({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.event}`,
        ),
      ).toEqual(["core/src/feature/bad.ts:1:totally-unknown", "plugins/example/src/index.ts:1:plugin-event"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores transport dispatch with a non-literal event argument", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/telemetry/service.ts",
        "export const dispatch = (sink, record) => sink.record(record.event, record.data);\n",
      );

      expect(await checkTelemetryInventory({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores non-telemetry record calls and test files", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/audit/log.ts",
        'export const a = (auditLog) => auditLog.record("anything", {});\n',
      );
      await write(
        root,
        "core/src/feature/bad.test.ts",
        'export const t = (telemetry) => telemetry.record("test-only-event", {});\n',
      );

      expect(await checkTelemetryInventory({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
