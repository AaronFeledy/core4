import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const lando = async (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const proc = Bun.spawn([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], {
    cwd,
    env: { ...(binary === undefined ? process.env : inherited), LANDO_TELEMETRY_ENABLED: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const hostProxyRunRoot = makeLandoPaths().hostProxyRunRoot;

// The worker record lives in a run directory derived from the app id and root.
const workerRecordFor = async (appRoot: string): Promise<{ readonly dir: string; readonly pid: number }> => {
  for (const entry of await readdir(hostProxyRunRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = join(hostProxyRunRoot, entry.name);
    const body = await readFile(join(dir, "worker.json"), "utf8").catch(() => undefined);
    if (body === undefined) continue;
    const record: unknown = JSON.parse(body);
    if (typeof record !== "object" || record === null) continue;
    if (Reflect.get(record, "appRoot") !== appRoot) continue;
    const pid = Reflect.get(record, "pid");
    if (typeof pid === "number") return { dir, pid };
  }
  throw new Error(`No host-proxy worker record for ${appRoot}.`);
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const probe = "echo HP=$LANDO_HOST_PROXY_SOCKET; ls /run/lando/host-proxy.sock";

const shimOpen = (root: string) =>
  lando(root, ["exec", "web", "--", "lando", "open", "--print", "--format=json"]);

// Only the host side answers runLando with an app:open envelope; the shim's own failures are plain text.
const expectHostProxied = (result: { readonly stdout: string; readonly stderr: string }) => {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const envelope: unknown = line.startsWith("{") ? JSON.parse(line) : undefined;
  expect(
    typeof envelope === "object" && envelope !== null ? Reflect.get(envelope, "command") : undefined,
    result.stdout + result.stderr,
  ).toBe("app:open");
};

test.skipIf(!liveEnabled)(
  "rebuild -s keeps the host-proxy session and a second start reuses the worker",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-reuse-live-"));
    const name = `hpreuse-${crypto.randomUUID().slice(0, 12)}`;
    let workerPid: number | undefined;
    let workerDir: string | undefined;
    const landofile = (extra: readonly string[]) =>
      [
        `name: ${name}`,
        "runtime: 4",
        "provider: lando",
        "router:",
        "  enabled: false",
        "services:",
        "  web:",
        "    type: lando",
        // The in-container shim is glibc-linked, so the service image must be glibc-based.
        "    image: docker.io/library/debian:bookworm-slim",
        "    home: false",
        "    command:",
        "      - sleep",
        "      - infinity",
        ...extra,
        "",
      ].join("\n");
    try {
      await Bun.write(join(root, ".lando.yml"), landofile([]));

      const started = await lando(root, ["start", "--format=json"]);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      const before = await lando(root, ["exec", "web", "--", "sh", "-c", probe]);
      expect(before.exitCode, before.stdout + before.stderr).toBe(0);
      expect(before.stdout).toContain("HP=/run/lando/host-proxy.sock");
      expectHostProxied(await shimOpen(root));
      ({ pid: workerPid, dir: workerDir } = await workerRecordFor(root));

      const rebuilt = await lando(root, ["rebuild", "-s", "web", "-y", "--format=json"]);
      expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
      const after = await lando(root, ["exec", "web", "--", "sh", "-c", probe]);
      expect(after.exitCode, after.stdout + after.stderr).toBe(0);
      expect(after.stdout).toContain("HP=/run/lando/host-proxy.sock");
      // The in-container shim round-trips through the host proxy with the current credentials.
      expectHostProxied(await shimOpen(root));
      expect((await workerRecordFor(root)).pid).toBe(workerPid);

      const restarted = await lando(root, ["start", "--format=json"]);
      expect(restarted.exitCode, restarted.stdout + restarted.stderr).toBe(0);
      expect((await workerRecordFor(root)).pid).toBe(workerPid);
      expect(processAlive(workerPid)).toBe(true);
      expectHostProxied(await shimOpen(root));

      // A Landofile edit recreates the changed service but keeps the host-proxy worker and its session.
      await Bun.write(
        join(root, ".lando.yml"),
        landofile(["    environment:", "      HP_REUSE_PROBE: edited"]),
      );
      const edited = await lando(root, ["start", "--format=json"]);
      expect(edited.exitCode, edited.stdout + edited.stderr).toBe(0);
      expect((await workerRecordFor(root)).pid).toBe(workerPid);
      const editedEnv = await lando(root, ["exec", "web", "--", "sh", "-c", "echo PROBE=$HP_REUSE_PROBE"]);
      expect(editedEnv.stdout).toContain("PROBE=edited");
      expectHostProxied(await shimOpen(root));
    } finally {
      const destroyed = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"]);
      await rm(root, { recursive: true, force: true });
      expect(destroyed.exitCode, destroyed.stdout + destroyed.stderr).toBe(0);
    }
    expect(workerPid).toBeDefined();
    if (workerPid !== undefined) expect(processAlive(workerPid)).toBe(false);
    if (workerDir !== undefined) expect(await stat(workerDir).catch(() => undefined)).toBeUndefined();
  },
  900_000,
);
