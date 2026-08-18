import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap.ts";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-report.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { RuntimeLayerFactory } from "../../src/testing/engine-layers.ts";

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;
const runtimeLayerFactoryLive = Layer.succeed(RuntimeLayerFactory, { make: makeLandoRuntime });

const runResilientDoctor = (env: Readonly<Record<string, string>>) =>
  Effect.runPromise(resilientDoctorReport({ env }).pipe(Effect.provide(runtimeLayerFactoryLive)));

const withUserDataRoot = async <A>(userDataRoot: string, run: () => Promise<A>): Promise<A> => {
  const priorDataRoot = process.env.LANDO_USER_DATA_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = userDataRoot;
    return await run();
  } finally {
    if (priorDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = priorDataRoot;
  }
};

describe("doctor installed-plugin metadata health", () => {
  test("validates package metadata without importing the plugin entry", async () => {
    // Given a valid plugin manifest whose entry would fail if imported
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-plugin-valid-metadata-"));
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginName = "@example/valid-metadata";
    const packageRoot = join(pluginsRoot, pluginName, "1.0.0");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({
        [pluginName]: { name: pluginName, version: "1.0.0", path: packageRoot },
      })}\n`,
    );
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        landoPlugin: { name: pluginName, version: "1.0.0", api: 4, entry: "index.js" },
      })}\n`,
    );
    await writeFile(
      join(packageRoot, "index.js"),
      'throw new Error("entry must not be imported by doctor");\n',
    );

    try {
      // When
      const report = await withUserDataRoot(userDataRoot, () => runResilientDoctor(SHORT_BUDGET_ENV));

      // Then valid metadata produces no metadata-health failure
      expect((report.self?.checks ?? []).some((check) => check.section === "plugin-metadata")).toBe(false);
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("reports missing package metadata without aborting the doctor report", async () => {
    // Given an installed plugin whose package metadata cannot be read
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-plugin-metadata-"));
    const pluginsRoot = join(userDataRoot, "plugins");
    const secret = "plugin-metadata-secret-4d8c";
    const pluginName = `@example/${secret}`;
    const packageRoot = join(pluginsRoot, pluginName, "1.0.0");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({
        [pluginName]: { name: pluginName, version: "1.0.0", path: packageRoot },
      })}\n`,
    );

    try {
      // When
      const report = await withUserDataRoot(userDataRoot, () =>
        runResilientDoctor({ ...SHORT_BUDGET_ENV, LANDO_TEST_TOKEN: secret }),
      );

      // Then the metadata failure is attributed, bounded, redacted, and isolated
      const metadataCheck = (report.self?.checks ?? []).find((check) => check.section === "plugin-metadata");
      expect(metadataCheck).toMatchObject({ status: "fail", severity: "error", reason: "failure" });
      expect(metadataCheck?.context.pluginId).toBe("@example/[redacted]");
      expect(metadataCheck?.context.pluginPath?.length).toBeLessThanOrEqual(2_000);
      expect((metadataCheck?.context.message ?? "").length).toBeLessThanOrEqual(2_000);
      expect(metadataCheck?.solutions.some((solution) => solution.command === "lando plugin list")).toBe(
        true,
      );
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("reports an invalid package manifest without aborting the doctor report", async () => {
    // Given an installed plugin whose package manifest fails schema validation
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-plugin-manifest-"));
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginName = "@example/invalid-manifest";
    const packageRoot = join(pluginsRoot, pluginName, "1.0.0");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({
        [pluginName]: { name: pluginName, version: "1.0.0", path: packageRoot },
      })}\n`,
    );
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ landoPlugin: { name: pluginName, version: "1.0.0", api: 3 } })}\n`,
    );

    try {
      // When
      const report = await withUserDataRoot(userDataRoot, () => runResilientDoctor(SHORT_BUDGET_ENV));

      // Then the invalid manifest is attributed and the report remains schema-valid
      const metadataCheck = (report.self?.checks ?? []).find((check) => check.section === "plugin-metadata");
      expect(metadataCheck).toMatchObject({
        status: "fail",
        severity: "error",
        context: { pluginId: pluginName, failure: "PluginManifestError" },
      });
      expect(metadataCheck?.context.metadataPath).toBe(join(packageRoot, "package.json"));
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("reports a corrupt registry without aborting the doctor report", async () => {
    // Given a plugin registry that cannot be parsed
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-plugin-registry-"));
    const pluginsRoot = join(userDataRoot, "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(join(pluginsRoot, "registry.json"), "{not-json", "utf8");

    try {
      // When
      const report = await withUserDataRoot(userDataRoot, () => runResilientDoctor(SHORT_BUDGET_ENV));

      // Then the corrupt registry is a structured failure and other sections still answer
      const metadataCheck = (report.self?.checks ?? []).find((check) => check.section === "plugin-metadata");
      expect(metadataCheck).toMatchObject({
        status: "fail",
        severity: "error",
        context: { pluginId: "registry" },
      });
      expect(metadataCheck?.context.metadataPath).toBe(join(pluginsRoot, "registry.json"));
      expect(report.subsystems.checks.length).toBeGreaterThan(0);
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
