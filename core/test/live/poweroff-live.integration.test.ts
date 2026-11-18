import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_LABEL, APP_ROOT_LABEL } from "@lando/container-runtime/labels";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, appIdentityKey } from "@lando/sdk/schema";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { Schema } from "effect";
import { AppsListResultSchema } from "../../src/cli/commands/list.ts";
import { requestJsonOnSocket } from "../../src/cli/commands/list-runtime-observation.ts";
import { PoweroffResultSchema } from "../../src/cli/commands/poweroff.ts";
import { ScratchListResultSchema, ScratchStartResultSchema } from "../../src/cli/commands/scratch.ts";
import { decodeStart } from "./route-cli-live-support.ts";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const childTimeout = 120_000;
const lando = async (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const proc = Bun.spawn(
    [...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args, "--format=json"],
    {
      cwd,
      env: { ...inherited, LANDO_PROVIDER: "lando", LANDO_TELEMETRY_ENABLED: "false" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: childTimeout,
      killSignal: "SIGKILL",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const cli = async (cwd: string, args: readonly string[]) => {
  const result = await lando(cwd, args);
  expect(result.exitCode, JSON.stringify({ cwd, args, ...result })).toBe(0);
  return result.stdout;
};

const writeLandofile = (
  app: { readonly id: string; readonly root: string },
  options: {
    readonly routed?: boolean;
    readonly hook?: { readonly event: "post-stop" | "pre-stop"; readonly cmd: string };
  } = {},
) => {
  // A PID 1 TERM trap keeps each stop from waiting out the grace period.
  const base = `name: ${app.id}
runtime: 4
provider: lando
router:
  enabled: ${options.routed ?? false}
services:
  web:
    type: compose
    image: docker.io/library/alpine:3.20
    home: false
    appMount: false
    user: root
    scanner: false
    command:
      - sh
      - -c
      - "trap 'exit 0' TERM; sleep infinity & wait"
`;
  const route = options.routed
    ? `    endpoints:
      - _tag: internal
        protocol: http
        port: 8080
    storage:
      - store: ${app.id}-data
        target: /data
    routes:
      - hostname: ${app.id}.lndo.site
        scheme: http
`
    : "";
  const { hook } = options;
  const events =
    hook === undefined
      ? ""
      : `events:
  ${hook.event}:
    - cmd: ${quoteYamlScalar(hook.cmd)}
      service: ":host"
`;
  return Bun.write(join(app.root, ".lando.yml"), base + route + events);
};

const appendHook = (marker: string, path: string) => `echo ${marker} >> '${path.replaceAll("'", "'\\''")}'`;
const hookCount = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).length;

const success = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), result })));
const listApps = async (cwd: string) =>
  success(AppsListResultSchema)(await cli(cwd, ["list", "--all"])).result.apps;
const listScratch = async (cwd: string) =>
  success(ScratchListResultSchema)(await cli(cwd, ["scratch:list"])).result;
const failure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Struct({
        _tag: Schema.Literal("PoweroffStopError"),
        failures: Schema.Array(
          Schema.Struct({
            _tag: Schema.NonEmptyString,
            message: Schema.String,
            remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
          }),
        ),
      }),
    }),
  ),
);
const appliedRecord = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String, root: Schema.String }) }),
);
const containers = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ State: Schema.String, Labels: Schema.Record(Schema.String, Schema.String) })),
);

test.skipIf(!liveEnabled)(
  "poweroff stops active apps with their hooks, removes scratch and orphan resources, and continues after a failed stop",
  async () => {
    const paths = makeLandoPaths();
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-poweroff-live-")));
    const name = `poweroff-${crypto.randomUUID().slice(0, 12)}`;
    const app = (letter: string, order: string) => ({
      id: `${name}-${letter}`,
      root: AbsolutePath.make(join(root, `${order}-${letter}`)),
    });
    const a = app("a", "10");
    const b = app("b", "20");
    const c = app("c", "30");
    const d = app("d", "00");
    const aLog = join(root, "a-hook.log");
    const bLog = join(root, "b-hook.log");
    const cleanup: Array<() => Promise<unknown>> = [];
    const prepare = async (fixture: typeof a, options: Parameters<typeof writeLandofile>[1]) => {
      await mkdir(fixture.root);
      await writeLandofile(fixture, options);
      cleanup.push(() => cli(fixture.root, ["destroy", "--yes", "--volumes"]));
    };
    const start = async (fixture: typeof a) => decodeStart(await cli(fixture.root, ["start"]));
    const inspect = (path: string) => requestJsonOnSocket(paths.providerSocketPath, path);
    const containerInventory = async (label: string) =>
      containers(
        await inspect(
          `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`,
        ),
      );
    const orphanVolume = Schema.decodeUnknownSync(Schema.Struct({ Name: Schema.String }));
    const volume = async () => orphanVolume(await inspect(`/volumes/${c.id}-data`)).Name;
    const routeFile = join(
      paths.globalAppRoot,
      "proxy-traefik",
      "dynamic",
      `routes-${appIdentityKey("owner", c.root)}.yml`,
    );
    let scratchId: string | undefined;
    const poweroff = async () => {
      const [listed, scratches, observed] = await Promise.all([
        listApps(root),
        listScratch(root),
        containerInventory(APP_LABEL),
      ]);
      const globalRoot = await realpath(paths.globalAppRoot);
      const owned = (id: string, appRoot: string) =>
        [a, b, c, d].some((fixture) => fixture.id === id && fixture.root === appRoot) ||
        (id === "global" && appRoot === globalRoot) ||
        (id === scratchId && appRoot === b.root);
      // List can report paused containers or unfinished starts as stopped. Refuse those records too.
      const foreign = [
        ...listed.map(({ appId, appRoot }) => ({ id: appId, root: appRoot })),
        ...scratches.map(({ id, app }) => ({ id, root: app.root })),
        ...observed
          .filter(({ State }) => !["exited", "stopped", "dead"].includes(State))
          .map(({ Labels }) => ({
            id: Labels[APP_LABEL] ?? "<unknown app>",
            root: Labels[APP_ROOT_LABEL] ?? "<unknown root>",
          })),
      ].filter(({ id, root: appRoot }) => !owned(id, appRoot));
      expect(foreign, `Refusing host-wide poweroff with foreign apps: ${JSON.stringify(foreign)}`).toEqual(
        [],
      );
      return lando(root, ["poweroff", "--keep-global"]);
    };

    try {
      await Bun.write(aLog, "");
      await Bun.write(bLog, "");
      await prepare(a, { routed: true, hook: { event: "post-stop", cmd: appendHook("a", aLog) } });
      await prepare(b, { hook: { event: "post-stop", cmd: appendHook("b", bLog) } });
      await prepare(c, { routed: true });
      await start(b);
      cleanup.push(async () => {
        for (const scratch of await listScratch(root)) {
          if (scratch.id === scratchId || scratch.app.root === b.root) {
            await cli(root, ["scratch:destroy", scratch.id, "--yes"]);
          }
        }
      });
      const scratch = success(ScratchStartResultSchema)(
        await cli(b.root, ["scratch:start", "--fork", "--detach", "--isolate=cwd"]),
      ).result.handle;
      scratchId = scratch.id;
      expect(scratch.app.root).toBe(b.root);
      await start(a);
      await start(c);
      await cli(b.root, ["stop"]);
      const aBefore = await hookCount(aLog);
      const bBefore = await hookCount(bLog);
      expect(bBefore).toBe(1);

      const appliedDir = join(paths.pluginStateDir("@lando/provider-lando"), "applied-plans");
      const candidates = (await readdir(appliedDir)).filter((name) => name.endsWith(".json"));
      const records = await Promise.all(
        candidates.map(async (name) => {
          const path = join(appliedDir, name);
          return { path, ...appliedRecord(await Bun.file(path).json()).data };
        }),
      );
      const matches = records.filter(({ id, root }) => id === c.id && root === c.root);
      const [orphan] = matches;
      if (matches.length !== 1 || orphan === undefined)
        throw new Error(`Expected one applied record for ${c.id} at ${c.root}`);
      expect(await Bun.file(routeFile).exists()).toBe(true);
      expect(await volume()).toBe(`${c.id}-data`);
      expect((await containerInventory(`${APP_ROOT_LABEL}=${c.root}`)).map(({ State }) => State)).toEqual([
        "running",
      ]);
      await rm(orphan.path);

      const stopped = await poweroff();
      expect(await hookCount(aLog), stopped.stdout + stopped.stderr).toBe(aBefore + 1);
      expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
      const result = success(PoweroffResultSchema)(stopped.stdout).result;
      expect(result.apps.find(({ appId }) => appId === a.id)).toMatchObject({ outcome: "stopped" });
      expect(result.apps.some(({ appId }) => appId === b.id)).toBe(false);
      expect(await hookCount(bLog)).toBe(bBefore);
      expect(result.apps.find(({ appId }) => appId === c.id)).toMatchObject({ outcome: "stopped" });
      expect(await containerInventory(`${APP_ROOT_LABEL}=${c.root}`)).toEqual([]);
      expect(await volume()).toBe(`${c.id}-data`);
      expect(await Bun.file(routeFile).exists()).toBe(false);
      expect(result.apps.find(({ appId }) => appId === scratch.id)).toMatchObject({ outcome: "destroyed" });
      expect((await listScratch(root)).some(({ id }) => id === scratch.id)).toBe(false);
      expect(result.apps.find(({ kind }) => kind === "global")).toMatchObject({
        appId: "global",
        outcome: "skipped",
      });
      expect(result).toMatchObject({ keptGlobalApp: true, runtimeServiceStopped: false });

      // Poweroff sorts by root: D must fail before A so a fail-fast regression cannot pass.
      await prepare(d, { hook: { event: "pre-stop", cmd: "exit 1" } });
      cleanup.push(() => writeLandofile(d));
      await start(d);
      await start(a);
      const failed = await poweroff();
      expect(failed.exitCode, failed.stdout + failed.stderr).toBeGreaterThan(0);
      const errors = failure(failed.stdout).error.failures;
      expect(
        errors.some(({ message }) => message.includes(d.id) && message.includes(d.root)),
        failed.stdout,
      ).toBe(true);
      expect((await listApps(root)).find(({ appId }) => appId === a.id)?.status).toBe("stopped");
      expect(await hookCount(aLog)).toBe(aBefore + 2);
    } finally {
      const failures: unknown[] = [];
      for (const finalize of cleanup.reverse()) {
        try {
          await finalize();
        } catch (cause) {
          failures.push(cause);
        }
      }
      expect(failures, `Poweroff fixture cleanup failed at ${root}`).toEqual([]);
      await rm(root, { recursive: true, force: true });
    }
  },
  24 * childTimeout,
);
