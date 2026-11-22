import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preflightDataRootPurge } from "@lando/container-runtime/data-root-purge";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { makeCleanupDiscoveredApps } from "@lando/engine/install/uninstall-discovery";
import type { ProviderPurgeHook } from "@lando/sdk/plugins";
import { Effect } from "effect";

const absentRuntime = () => Object.assign(new Error("runtime unavailable"), { code: "ENOENT" });

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
  const state = join(data, "providers", "provider-lando");
  mkdirSync(state, { recursive: true });
  const createdAt = "2026-09-23T00:00:00Z";
  writeFileSync(
    join(state, "setup-state.json"),
    JSON.stringify({ machine: { name: "lando", createdByLando: true, createdAt } }),
  );
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
    if (!file.startsWith(data)) throw absentRuntime();
    if (args[0] === "machine") return { stdout: JSON.stringify([{ Created: createdAt }]) };
    if (args.includes("--version")) return { stdout: "podman" };
    if (args.includes("df"))
      return {
        stdout: JSON.stringify([
          { Type: "Containers", Total: 0 },
          { Type: "Local Volumes", Total: 0 },
        ]),
      };
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

test.each(["current", "peer"] as const)(
  "Windows guards only this data root's sync on a reused VM: %s",
  async (syncOwner) => {
    const root = mkdtempSync(join(tmpdir(), "lando-reused-vm-sync-"));
    const data = join(root, "data");
    const state = join(data, "providers", "provider-lando");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "setup-state.json"),
      JSON.stringify({ machine: { name: "lando", createdByLando: false } }),
    );
    const order: string[] = [];
    let ownedPresent = true;
    const purge: ProviderPurgeHook = (input) => {
      const syncRoot = syncOwner === "current" ? input.dataRoot : join(root, "peer");
      const api: EngineHttpApi = {
        request: ({ method, path }) =>
          Effect.sync(() => {
            const json = (value: unknown, status = 200) => ({ status, body: JSON.stringify(value) });
            if (path === "/_ping") {
              order.push("preflight:vm");
              return json(null);
            }
            if (path.startsWith("/containers/json?")) return json(ownedPresent ? [{ Id: "owned" }] : []);
            if (path === "/containers/owned/json")
              return json({
                Id: "owned",
                Config: {
                  Labels: {
                    "dev.lando.app": "web",
                    "dev.lando.app-root": root,
                    "dev.lando.service": "web",
                    "dev.lando.data-root": input.dataRoot,
                  },
                },
              });
            if (method === "POST" && path.startsWith("/containers/owned/stop")) {
              order.push("stop:owned");
              return json(null, 204);
            }
            if (method === "DELETE" && path.startsWith("/containers/owned?")) {
              ownedPresent = false;
              return json(null, 204);
            }
            if (path.startsWith("/volumes?")) return json({ Volumes: [{ Name: "sync" }] });
            if (path === "/volumes/sync")
              return json({
                Name: "sync",
                Labels: { "dev.lando.data-root": syncRoot, "dev.lando.sync.kind": "volume" },
              });
            if (path.startsWith("/images/json?") || path.startsWith("/networks?")) return json([]);
            throw new Error(`Unexpected request ${method} ${path}`);
          }),
      };
      return preflightDataRootPurge(
        api,
        { providerId: "lando", env: {}, remediation: "Retry" },
        { ...input, endpoint: "fixture-vm", pluginId: "@lando/provider-lando" },
      );
    };
    const cleanup = makeCleanupDiscoveredApps(
      data,
      async () => {
        throw new Error("Reused VM must not use lando-root or verify whole storage");
      },
      "win32",
      {},
      [
        { providerId: "lando", purge },
        {
          providerId: "docker",
          purge: () =>
            Effect.sync(() => {
              order.push("preflight:docker");
              return { kind: "skipped", endpoint: "fixture-docker", reason: "Unavailable" };
            }),
        },
      ],
    );
    try {
      if (syncOwner === "current")
        await expect(cleanup([], join(root, "cache"))).rejects.toThrow(
          "Accelerated sync helper or volume exists for this data root",
        );
      else await cleanup([], join(root, "cache"));
      expect(ownedPresent).toBe(syncOwner === "current");
      expect(order).toEqual(
        syncOwner === "current"
          ? ["preflight:vm", "preflight:docker"]
          : ["preflight:vm", "preflight:docker", "stop:owned"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
      expect(fixture.calls.some((call) => call.includes("prune"))).toBe(false);
      expect(fixture.calls.some((call) => call.includes("network") && call.includes("ls"))).toBe(true);
      expect(fixture.calls.some((call) => call.includes("--connection") && call.includes("lando-root"))).toBe(
        true,
      );
      expect(
        fixture.calls.every((call) => !call.includes("--runroot") && !call.includes("--storage-opt")),
      ).toBe(true);
      expect(
        fixture.probes.some((probe) => probe.file === join(fixture.data, "runtime", "bin", "podman.exe")),
      ).toBe(true);
      // Machine connections resolve from the user's Podman config, as Windows exec does.
      expect(
        fixture.probes.find((probe) => probe.file.endsWith("podman.exe"))?.env?.XDG_CONFIG_HOME,
      ).not.toBe(join(fixture.data, "runtime", "config"));
      const firstSweep = fixture.calls.findIndex((call) => call.includes("label=dev.lando.app"));
      expect(firstSweep).toBeGreaterThan(
        fixture.calls.findIndex(
          (call) => call.includes("ls") && call.includes("label=dev.lando.sync.kind=volume"),
        ),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each(["managed"] as const)(
    "removes anonymous volumes with scoped Linux cleanup on %s",
    async (runtime) => {
      // Given: only the selected runtime is available, with containers under both Lando labels.
      const fixture = await withRuntime("ordinary");
      try {
        const command = runtime === "managed" ? join(fixture.data, "runtime", "bin", "podman") : runtime;
        const prefix =
          runtime === "managed"
            ? [
                "--root",
                join(fixture.data, "runtime", "storage"),
                "--runroot",
                join(fixture.data, "runtime", "run"),
                "--config",
                join(fixture.data, "runtime", "config"),
                "--storage-opt",
                `overlay.mount_program=${join(fixture.data, "runtime", "bin", "fuse-overlayfs")}`,
              ]
            : [];
        const calls: string[][] = [];
        const exec = async (file: string, args: ReadonlyArray<string>) => {
          if (file !== command) throw absentRuntime();
          if (args.includes("--version")) return { stdout: "podman" };
          calls.push([...args]);
          if (args.includes("ps"))
            return {
              stdout:
                args.includes(`label=dev.lando.data-root=${fixture.data}`) ||
                args.includes("label=dev.lando.app")
                  ? "current-id\nsecond-id\n"
                  : "legacy-id\n",
            };
          if (args.includes("inspect")) {
            const id = args.at(-1) ?? "";
            return {
              stdout: JSON.stringify([
                {
                  Id: `exact-${id}`,
                  Config: {
                    Labels:
                      runtime === "managed"
                        ? { "com.lando.app": "legacy" }
                        : {
                            "dev.lando.app": "demo",
                            "dev.lando.app-root": fixture.root,
                            "dev.lando.service": "web",
                            "dev.lando.data-root": fixture.data,
                          },
                  },
                },
              ]),
            };
          }
          if (args.includes("df"))
            return {
              stdout: JSON.stringify([
                { Type: "Containers", Total: 0 },
                { Type: "Local Volumes", Total: 0 },
              ]),
            };
          return { stdout: "" };
        };
        // When: purge sweeps the runtime through injected execution only.
        await makeCleanupDiscoveredApps(fixture.data, exec, "linux")([]);
        // Then: candidate labels discover only; inspected exact IDs authorize removal.
        expect(calls.filter((call) => call.includes("inspect") || call.includes("rm"))).toEqual([
          [...prefix, "container", "inspect", "current-id"],
          [...prefix, "rm", "-f", "--volumes", "exact-current-id"],
          [...prefix, "container", "inspect", "second-id"],
          [...prefix, "rm", "-f", "--volumes", "exact-second-id"],
          ...(runtime === "managed"
            ? [
                [...prefix, "container", "inspect", "legacy-id"],
                [...prefix, "rm", "-f", "--volumes", "exact-legacy-id"],
              ]
            : []),
        ]);
        if (runtime !== "managed")
          expect(calls[0]).toEqual([
            ...prefix,
            "ps",
            "-a",
            "--filter",
            `label=dev.lando.data-root=${fixture.data}`,
            "--format",
            "{{.ID}}",
          ]);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

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
    ]) {
      const fixture = await withRuntime("ordinary");
      try {
        const stateDir = join(fixture.data, "providers", "provider-lando");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "setup-state.json"), JSON.stringify(state));
        const calls: string[][] = [];
        const exec = async (file: string, args: ReadonlyArray<string>) => {
          calls.push([...args]);
          if (file.endsWith("podman.exe")) throw absentRuntime();
          throw absentRuntime();
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
        if (args[0] === "machine") return { stdout: '[{"Created":"2026-09-23T00:00:00Z"}]' };
        if (file === "podman") throw absentRuntime();
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
