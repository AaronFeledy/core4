import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCleanupDiscoveredApps } from "../../src/cli/command-specs/meta/uninstall.ts";

type Scenario =
  | "stopped-helper"
  | "running-helper"
  | "volume"
  | "unlabeled-helper"
  | "unlabeled-volume"
  | "query-failure"
  | "ordinary";
const withRuntime = async (scenario: Scenario) => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-sync-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const calls: string[][] = [];
  const probes: Array<{ file: string; env?: NodeJS.ProcessEnv }> = [];
  const exec = async (
    file: string,
    args: ReadonlyArray<string>,
    options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
  ) => {
    const call = [...args];
    calls.push(call);
    probes.push({ file, ...(options.env === undefined ? {} : { env: options.env }) });
    if (!file.startsWith(data)) throw new Error("runtime unavailable");
    if (args.includes("--version")) return { stdout: "podman" };
    if (args.includes("ps") && args.includes("label=dev.lando.sync.kind=helper"))
      return {
        stdout: scenario === "stopped-helper" || scenario === "running-helper" ? "sync-helper-id\\n" : "",
      };
    if (args.includes("ls") && args.includes("label=dev.lando.sync.kind=volume")) {
      if (scenario === "query-failure") throw new Error("volume list failed");
      return { stdout: scenario === "volume" ? "orphan-sync-volume\\n" : "" };
    }
    if (args.includes("{{.Names}}"))
      return { stdout: scenario === "unlabeled-helper" ? "lando-sync-cms-0123456789abcdef" : "" };
    if (args.includes("ls") && args.includes("{{.Name}}"))
      return { stdout: scenario === "unlabeled-volume" ? "cms-app-app-mount" : "" };
    return { stdout: "" };
  };
  return { root, data, calls, probes, run: makeCleanupDiscoveredApps(data, exec, "win32") };
};

const destructive = (call: string[]): boolean =>
  call.includes("stop") || call.includes("rm") || call.includes("prune");

describe("uninstall purge sync guard", () => {
  for (const scenario of [
    "stopped-helper",
    "running-helper",
    "volume",
    "unlabeled-helper",
    "unlabeled-volume",
    "query-failure",
  ] as const) {
    test(`preserves runtime on ${scenario}`, async () => {
      const fixture = await withRuntime(scenario);
      try {
        let failure: unknown;
        try {
          await fixture.run([]);
        } catch (cause) {
          failure = cause;
        }
        expect(String(failure)).toContain("Cannot safely purge");
        expect(fixture.calls.some(destructive)).toBe(false);
        expect(fixture.calls.some((call) => call.includes("ps") && call.includes("-a"))).toBe(true);
        expect(fixture.calls.some((call) => call.includes("ls"))).toBe(true);
        if (scenario === "unlabeled-helper")
          expect(fixture.calls.some((call) => call.includes("{{.Names}}"))).toBe(true);
        if (scenario === "unlabeled-volume")
          expect(
            fixture.calls.some(
              (call) => call.includes("{{.Name}}") && !call.some((arg) => arg.startsWith("label=")),
            ),
          ).toBe(true);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  test("sweeps ordinary Lando resources after a clean preflight", async () => {
    const fixture = await withRuntime("ordinary");
    try {
      await fixture.run([]);
      expect(fixture.calls.some((call) => call.includes("prune"))).toBe(true);
      expect(fixture.calls.some((call) => call.includes("--connection") && call.includes("lando-root"))).toBe(
        true,
      );
      expect(
        fixture.calls.every((call) => !call.includes("--runroot") && !call.includes("--storage-opt")),
      ).toBe(true);
      expect(
        fixture.probes.some((probe) => probe.file === join(fixture.data, "runtime", "bin", "podman.exe")),
      ).toBe(true);
      expect(fixture.probes.find((probe) => probe.file.endsWith("podman.exe"))?.env?.XDG_CONFIG_HOME).toBe(
        join(fixture.data, "runtime", "config"),
      );
      const firstPrune = fixture.calls.findIndex(destructive);
      expect(firstPrune).toBeGreaterThan(
        fixture.calls.findIndex(
          (call) => call.includes("ls") && call.includes("label=dev.lando.sync.kind=volume"),
        ),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps the ordinary Linux cleanup path independent of Windows sync queries", async () => {
    const fixture = await withRuntime("ordinary");
    try {
      const calls: string[][] = [];
      const exec = async (file: string, args: ReadonlyArray<string>) => {
        calls.push([...args]);
        if (!file.startsWith(fixture.data)) throw new Error("runtime unavailable");
        if (args.includes("--version")) return { stdout: "podman" };
        if (args.includes("dev.lando.sync.kind=volume")) throw new Error("Windows-only query");
        return { stdout: "" };
      };
      await makeCleanupDiscoveredApps(fixture.data, exec, "linux")([]);
      expect(calls.some((call) => call.includes("prune"))).toBe(true);
      expect(calls.some((call) => call.includes("dev.lando.sync.kind=volume"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves runtime for saved accelerated or unreadable plans", async () => {
    for (const body of [
      JSON.stringify({ version: 1, data: { fileSync: [{}], services: {} } }),
      JSON.stringify({ version: 1, data: { fileSync: [], services: { web: { mounts: "bad" } } } }),
      "{bad-json",
    ]) {
      const fixture = await withRuntime("ordinary");
      try {
        const plans = join(fixture.data, "plugins", "@lando", "provider-lando", "applied-plans");
        mkdirSync(plans, { recursive: true });
        writeFileSync(join(plans, "app.json"), body);
        let failure: unknown;
        try {
          await fixture.run([]);
        } catch (cause) {
          failure = cause;
        }
        expect(String(failure)).toContain("saved plan app.json");
        expect(fixture.calls.some(destructive)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("preserves runtime for durable Mutagen session or unreadable ledger", async () => {
    for (const body of [JSON.stringify({ version: 1, data: { sessions: [{}] } }), "{bad-json"]) {
      const fixture = await withRuntime("ordinary");
      try {
        const sessions = join(fixture.data, "plugins", "@lando", "file-sync-mutagen", "sessions");
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, "mutagen.json"), body);
        let failure: unknown;
        try {
          await fixture.run([]);
        } catch (cause) {
          failure = cause;
        }
        expect(String(failure)).toContain("durable Mutagen");
        expect(fixture.calls.some(destructive)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("preserves a recorded Windows machine when its bundled Podman binary is missing", async () => {
    for (const state of [
      { machine: { name: "lando", createdByLando: true, createdAt: "2026-09-23T00:00:00Z" } },
      { machine: { name: "lando", createdByLando: true } },
    ]) {
      const fixture = await withRuntime("ordinary");
      try {
        const stateDir = join(fixture.data, "providers", "provider-lando");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "setup-state.json"), JSON.stringify(state));
        const calls: string[][] = [];
        const exec = async (file: string, args: ReadonlyArray<string>) => {
          calls.push([...args]);
          if (file.endsWith("podman.exe")) throw new Error("missing bundled binary");
          throw new Error("runtime unavailable");
        };
        let failure: unknown;
        try {
          await makeCleanupDiscoveredApps(fixture.data, exec, "win32")([]);
        } catch (cause) {
          failure = cause;
        }
        expect(String(failure)).toContain("recorded Windows managed machine");
        expect(calls.some(destructive)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("finishes all runtime preflights before the first sweep", async () => {
    const fixture = await withRuntime("ordinary");
    try {
      const calls: string[][] = [];
      const exec = async (file: string, args: ReadonlyArray<string>) => {
        calls.push([...args]);
        if (file === "podman") throw new Error("runtime unavailable");
        if (args.includes("--version")) return { stdout: "podman" };
        if (file.startsWith(fixture.data) && args.includes("label=dev.lando.sync.kind=helper"))
          return { stdout: "late-helper-id" };
        return { stdout: "" };
      };
      let failure: unknown;
      try {
        await makeCleanupDiscoveredApps(fixture.data, exec, "win32")([]);
      } catch (cause) {
        failure = cause;
      }
      expect(String(failure)).toContain("Cannot safely purge");
      expect(
        calls.some((call) => call.includes("ps") && call.includes("label=dev.lando.sync.kind=helper")),
      ).toBe(true);
      expect(calls.some(destructive)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
