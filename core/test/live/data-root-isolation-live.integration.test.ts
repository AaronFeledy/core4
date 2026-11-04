import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { InfoAppResult } from "@lando/sdk/schema";
import { Schema } from "effect";

import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

const binary = resolve(process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"));
const prerequisite =
  process.platform !== "linux"
    ? "The managed runtime's per-data-root isolation is Linux-only."
    : !isScannerLiveEligible()
      ? `Set LANDO_TEST_PODMAN_SOCKET to the answering managed socket ${managedProviderSocketPath} and preserve that installation's LANDO_USER_* roots.`
      : Bun.which(binary) === null
        ? `Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY; missing ${binary}.`
        : Bun.which("curl") === null
          ? "Install curl in the live-test environment."
          : undefined;

const LaunchState = Schema.fromJsonString(
  Schema.Struct({ env: Schema.Struct({ XDG_RUNTIME_DIR: Schema.optional(Schema.String) }) }),
);
const Acquisition = Schema.fromJsonString(
  Schema.Struct({ httpPort: Schema.Number, httpsPort: Schema.Number }),
);
const InfoEnvelope = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult }),
);
const UninstallEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({
      steps: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
    }),
  }),
);

const HELPER_PATHS = [
  "/etc/systemd/system/lando-proxy-http.socket",
  "/etc/systemd/system/lando-proxy-http.service",
  "/etc/systemd/system/lando-proxy-https.socket",
  "/etc/systemd/system/lando-proxy-https.service",
] as const;

type Roots = { readonly data: string; readonly conf: string; readonly cache: string };

const inheritedRoots = (): Roots => {
  const data = process.env.LANDO_USER_DATA_ROOT;
  const conf = process.env.LANDO_USER_CONF_ROOT;
  const cache = process.env.LANDO_USER_CACHE_ROOT;
  if (data === undefined || conf === undefined || cache === undefined) {
    throw new Error(
      "The live job must export LANDO_USER_DATA_ROOT, LANDO_USER_CONF_ROOT, and LANDO_USER_CACHE_ROOT.",
    );
  }
  return { data, conf, cache };
};

// The managed service records the private runtime dir it launched with; a pre-isolation service has none.
const runtimeDirOf = (roots: Roots): string => {
  const recorded = Schema.decodeUnknownSync(LaunchState)(
    readFileSync(join(roots.data, "runtime/run/podman.pid.launch.json"), "utf8"),
  ).env.XDG_RUNTIME_DIR;
  return recorded ?? `/run/user/${process.getuid?.() ?? 0}`;
};

const pausePid = (runtimeDir: string): number =>
  Number(readFileSync(join(runtimeDir, "libpod/tmp/pause.pid"), "utf8").trim());

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const environOf = (pid: number): readonly string[] =>
  readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");

const acquisitionOf = (roots: Roots) =>
  Schema.decodeUnknownSync(Acquisition)(
    readFileSync(join(roots.data, "global/proxy-traefik/dynamic/.lando-port-acquisition.json"), "utf8"),
  );

const helperDigests = (): readonly string[] =>
  HELPER_PATHS.map((path) =>
    existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent",
  );

const spawnText = async (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
) => {
  const proc = Bun.spawn([...argv], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

// Embedded Bun uses BUN_BE_BUN=1; compiled CLI children must dispatch Lando instead.
const cliEnv = (roots: Roots, extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      key === "BUN_BE_BUN" || value === undefined ? [] : [[key, value]],
    ),
  ),
  LANDO_USER_DATA_ROOT: roots.data,
  LANDO_USER_CONF_ROOT: roots.conf,
  LANDO_USER_CACHE_ROOT: roots.cache,
  LANDO_PROVIDER: "lando",
  LANDO_TELEMETRY_ENABLED: "false",
  ...extra,
});

const lando = async (
  roots: Roots,
  cwd: string,
  args: readonly string[],
  options: { readonly timeout?: number; readonly env?: Record<string, string> } = {},
) => {
  const result = await spawnText(
    [binary, ...args, "--format=json"],
    cwd,
    cliEnv(roots, options.env),
    options.timeout ?? 120_000,
  );
  expect(result.exitCode, JSON.stringify({ args, ...result })).toBe(0);
  return result.stdout.trim().split("\n").at(-1) ?? "";
};

const managedApiAnswers = async (roots: Roots): Promise<boolean> => {
  const result = await spawnText(
    [
      "curl",
      "--silent",
      "--max-time",
      "5",
      "--unix-socket",
      join(roots.data, "runtime/run/podman.sock"),
      "http://d/_ping",
    ],
    "/",
    { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    10_000,
  );
  return result.exitCode === 0 && result.stdout.trim() === "OK";
};

describe.serial("two Lando data roots on one host", () => {
  test.skipIf(prerequisite !== undefined && process.env.LANDO_GUIDE_E2E !== "1")(
    "a second data root runs, routes, powers off, and purges without touching the first",
    async () => {
      if (prerequisite !== undefined) throw new Error(prerequisite);
      const first = inheritedRoots();
      const scratch = await mkdtemp(join(tmpdir(), "ldr-"));
      const second: Roots = { data: join(scratch, "d"), conf: join(scratch, "c"), cache: join(scratch, "k") };
      expect(second.data).not.toBe(first.data);
      // A shell that points Podman at some other daemon must not leak into the managed runtime.
      const hostileShell = { CONTAINER_HOST: "unix:///nonexistent/lando-isolation.sock" };
      const app = join(scratch, "app");
      const name = `isolation-${crypto.randomUUID().slice(0, 8)}`;
      const body = `second-root-${crypto.randomUUID()}`;
      try {
        // Given: the first root's router holds its pair and its runtime has a pause process.
        await lando(first, scratch, ["global:start"], { timeout: 300_000 });
        const firstRuntimeDir = runtimeDirOf(first);
        const firstPause = pausePid(firstRuntimeDir);
        const firstPorts = acquisitionOf(first);
        const firstAcquisition = readFileSync(
          join(first.data, "global/proxy-traefik/dynamic/.lando-port-acquisition.json"),
          "utf8",
        );
        const helperBefore = helperDigests();
        expect(isAlive(firstPause)).toBe(true);

        // When: a second root sets up its own managed runtime and starts a routed app.
        await lando(
          second,
          scratch,
          ["setup", "--yes", "--skip-install-ca", "--skip-shell-integration", "--skip-file-sync"],
          { timeout: 600_000, env: hostileShell },
        );
        const secondRuntimeDir = runtimeDirOf(second);
        const secondPause = pausePid(secondRuntimeDir);
        await mkdir(join(app, "public"), { recursive: true });
        await chmod(app, 0o755);
        await Bun.write(join(app, "public/index.html"), body);
        await Bun.write(
          join(app, ".lando.yml"),
          [`name: ${name}`, "services:", "  web:", "    type: nginx", "    webroot: public", ""].join("\n"),
        );
        await lando(second, app, ["start"], { timeout: 300_000, env: hostileShell });
        const info = Schema.decodeUnknownSync(InfoEnvelope)(await lando(second, app, ["info"]));
        const route = info.result.services
          .find((service) => service.service === "web")
          ?.connections.find(
            (connection) => connection.source === "route" && connection.binding === "assigned",
          );
        if (route === undefined || !("url" in route) || route.url === undefined) {
          throw new Error(`info published no assigned route for ${name}`);
        }
        const url = new URL(route.url);
        const served = await spawnText(
          [
            "curl",
            "--silent",
            "--fail",
            "--noproxy",
            "*",
            "--max-time",
            "10",
            "--resolve",
            `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}:127.0.0.1`,
            // Trust relaxation is confined to this unique fixture host.
            ...(url.protocol === "https:" ? ["--insecure"] : []),
            url.toString(),
          ],
          app,
          { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          15_000,
        );

        // Then: the second root has its own runtime dir, pause process, and router ports, and serves its app.
        expect(secondRuntimeDir).not.toBe(firstRuntimeDir);
        expect(secondPause).not.toBe(firstPause);
        expect(environOf(secondPause)).toContain(`XDG_RUNTIME_DIR=${secondRuntimeDir}`);
        const secondPorts = acquisitionOf(second);
        expect([secondPorts.httpPort, secondPorts.httpsPort]).not.toContain(firstPorts.httpPort);
        expect([secondPorts.httpPort, secondPorts.httpsPort]).not.toContain(firstPorts.httpsPort);
        expect(served.stdout).toBe(body);

        // And: start after poweroff relaunches the second runtime.
        await lando(second, app, ["poweroff"], { timeout: 300_000 });
        expect(isAlive(secondPause)).toBe(false);
        await lando(second, app, ["start"], { timeout: 300_000 });
        await lando(second, app, ["poweroff"], { timeout: 300_000 });

        // And: purging the second root touches only the second root.
        const plan = Schema.decodeUnknownSync(UninstallEnvelope)(
          await lando(second, scratch, ["uninstall", "--dry-run", "--purge"]),
        );
        expect(plan.result.steps.find((step) => step.id === "user-data-root")?.target).toBe(second.data);
        await lando(second, scratch, ["uninstall", "--yes", "--purge"], { timeout: 300_000 });
        expect(existsSync(secondRuntimeDir)).toBe(false);
        expect(existsSync(second.data)).toBe(false);

        expect(isAlive(firstPause)).toBe(true);
        expect(await managedApiAnswers(first)).toBe(true);
        expect(
          readFileSync(join(first.data, "global/proxy-traefik/dynamic/.lando-port-acquisition.json"), "utf8"),
        ).toBe(firstAcquisition);
        expect(helperDigests()).toEqual(helperBefore);
      } finally {
        if (existsSync(second.data)) {
          await spawnText([binary, "poweroff"], scratch, cliEnv(second), 300_000);
          await spawnText([binary, "uninstall", "--yes", "--purge"], scratch, cliEnv(second), 300_000);
        }
        await rm(scratch, { recursive: true, force: true });
      }
    },
    1_800_000,
  );
});
