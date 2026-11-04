import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  assertLifecycleHostIsolation,
  assertLifecycleRuntimeIsolation,
  assertLifecycleWindowsMachineAbsent,
} from "../../../scripts/install-lifecycle-journey-preflight.ts";
import { runInstallLifecycleJourney } from "../../../scripts/install-lifecycle-journey.ts";

const plan = (id: string, status: string) =>
  JSON.stringify({
    result: {
      dryRun: true,
      refused: false,
      mode: "purge",
      failed: false,
      steps: [{ id, label: id, target: "/host/global-integration", destructive: true, status, detail: "" }],
    },
  });

test.each(["socket-proxy-helper", "cgroups-delegate"])("refuses existing %s before installing", (id) => {
  // Given production uninstall would reach an existing host-global integration.
  const dryRun = plan(id, "owned");
  // When preflight checks its real dry-run projection.
  const check = () => assertLifecycleHostIsolation(dryRun);
  // Then root isolation cannot be mistaken for host isolation.
  expect(check).toThrow("Fresh host required");
});

test("accepts a host without global integration", () => {
  // Given no host-global uninstall target exists.
  const dryRun = plan("socket-proxy-helper", "skipped");
  // When preflight checks the production projection.
  const check = () => assertLifecycleHostIsolation(dryRun);
  // Then a dedicated clean runner can proceed.
  expect(check).not.toThrow();
});

test("rejects malformed uninstall safety evidence", () => {
  // Given dry-run evidence is not a valid production result.
  const dryRun = "{}";
  // When preflight parses it.
  const check = () => assertLifecycleHostIsolation(dryRun);
  // Then missing evidence cannot become permission to purge.
  expect(check).toThrow();
});

test.each([0, 1, 2, 3])("refuses pre-existing runtime resources from query %i", async (foreignIndex) => {
  // Given one protected resource family is nonempty.
  let index = 0;
  const calls: string[][] = [];
  const run = async (_id: string, argv: readonly string[]) => {
    calls.push([...argv]);
    return index++ === foreignIndex ? "foreign-resource\n" : "";
  };
  // When runtime preflight enumerates the same resource families uninstall sweeps.
  const result = assertLifecycleRuntimeIsolation("docker", run);
  // Then it refuses, using read-only queries only.
  await expect(result).rejects.toThrow("Fresh runtime required");
  expect(calls.every((argv) => argv.includes("ls") || argv.includes("ps"))).toBe(true);
});

test("propagates runtime discovery failure instead of treating it as empty", async () => {
  // Given the runtime cannot answer read-only inventory.
  const failure = new Error("runtime unavailable");
  const run = async () => {
    throw failure;
  };
  // When preflight probes it.
  const result = assertLifecycleRuntimeIsolation("docker", run);
  // Then setup is not reached under a guessed safety verdict.
  await expect(result).rejects.toBe(failure);
});

test("rejects a checkout work directory before creating any lifecycle resources", async () => {
  const result = runInstallLifecycleJourney({
    binary: process.execPath,
    workDir: resolve(import.meta.dirname, "../../.."),
    report: "unused.json",
    provider: "docker",
  });
  await expect(result).rejects.toThrow("--work-dir must be outside the checkout");
});

test.each(["podman-lando\r\n", "p\0o\0d\0m\0a\0n\0-\0l\0a\0n\0d\0o\0"])(
  "rejects existing Windows machine in WSL output %p",
  (listing) => {
    expect(() => assertLifecycleWindowsMachineAbsent(listing)).toThrow();
  },
);

test("accepts Windows machine removal only when its registration is absent", () => {
  expect(() => assertLifecycleWindowsMachineAbsent("Ubuntu\r\n")).not.toThrow();
});

test("CLI refuses an undeclared shared host before any Lando command", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-host-contract-"));
  try {
    const report = join(root, "report.json");
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dirname, "../../../scripts/install-lifecycle-journey.ts"),
        "--binary",
        process.execPath,
        "--work-dir",
        join(root, "run"),
        "--report",
        report,
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "LANDO_LIFECYCLE_FRESH_RUNNER"),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const result = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          commands: Schema.Array(Schema.Unknown),
          classification: Schema.Struct({ exitCode: Schema.Number }),
        }),
      ),
    )(await Bun.file(report).text());
    expect(exitCode).toBe(1);
    expect(result.classification.exitCode).toBe(1);
    expect(result.commands).toEqual([]);
    expect(await Bun.file(join(root, "run", "installed", "lando")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
