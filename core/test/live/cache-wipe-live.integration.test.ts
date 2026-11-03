import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { InfoAppResult } from "@lando/sdk/schema";
import { Schema } from "effect";

const socket = resolveLiveProviderSocket();
const required = process.env.LANDO_GUIDE_E2E === "1";
const childTimeout = 240_000;
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const compiled = resolve(import.meta.dir, "../../dist/lando");
const envelope = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown });
const outputSchema = Schema.fromJsonString(
  Schema.Union([envelope, Schema.Struct({ _tag: Schema.Literal("result"), envelope })]),
);
const scratchSummary = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literal("full"),
  status: Schema.Literal("detached"),
  source: Schema.Struct({ kind: Schema.Literal("fork") }),
});

test.skipIf(socket === undefined && !required)(
  "app lifecycle and detached scratch survive deleting the user cache between commands",
  async () => {
    if (socket === undefined) throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required.");
    const directory = await mkdtemp(join(tmpdir(), "lando-cache-wipe-live-"));
    const root = join(directory, "app");
    const cache = join(directory, "cache");
    const name = `cache-wipe-${crypto.randomUUID().slice(0, 8)}`;
    const binary = process.env.LANDO_SCENARIO_E2E_BINARY ?? Bun.which(compiled) ?? undefined;
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "BUN_BE_BUN" && !key.startsWith("LANDO_CONFIG__"),
        ),
      ),
      LANDO_USER_CONF_ROOT: join(directory, "config"),
      LANDO_USER_DATA_ROOT: join(directory, "data"),
      LANDO_USER_CACHE_ROOT: cache,
      LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
      LANDO_PROVIDER: "podman",
      DOCKER_HOST: `unix://${socket.socketPath}`,
      LANDO_CONFIG__default_provider_id: "podman",
      LANDO_TELEMETRY_ENABLED: "false",
    };
    const lando = async (args: readonly string[]) => {
      const proc = Bun.spawn(
        [...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args, "--format=json"],
        {
          cwd: root,
          env,
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
    const cli = async (args: readonly string[]) => {
      const result = await lando(args);
      expect(result.exitCode, JSON.stringify({ args, ...result })).toBe(0);
      const output = Schema.decodeUnknownSync(outputSchema)(result.stdout.trim().split("\n").at(-1) ?? "");
      return ("envelope" in output ? output.envelope : output).result;
    };
    // Track every observed id until its explicit destroy succeeds.
    const scratchIds = new Set<string>();
    await mkdir(root);
    try {
      await Bun.write(
        join(root, ".lando.yml"),
        `name: ${name}
runtime: 4
provider: podman
router:
  enabled: false
services:
  web:
    type: compose
    image: docker.io/library/alpine:3.20
    home: false
    appMount: false
    user: root
    command:
      - sleep
      - infinity
`,
      );
      // Cleanup is armed before the first start, including a partially failed apply (#1978).
      await cli(["start"]);
      await rm(cache, { recursive: true, force: true });
      const firstInfo = Schema.decodeUnknownSync(InfoAppResult)(await cli(["info"]));
      expect(firstInfo.services.map(({ service, status }) => ({ service, status }))).toEqual([
        { service: "web", status: "running" },
      ]);
      await cli(["stop"]);
      await rm(cache, { recursive: true, force: true });
      await cli(["start"]);
      const restartedInfo = Schema.decodeUnknownSync(InfoAppResult)(await cli(["info"]));
      expect(restartedInfo.services.map(({ service, status }) => ({ service, status }))).toEqual([
        { service: "web", status: "running" },
      ]);

      const scratch = Schema.decodeUnknownSync(
        Schema.Struct({
          handle: Schema.Struct({ id: Schema.String }),
          detached: Schema.Boolean,
        }),
      )(await cli(["scratch:start", "--fork", "--detach", "--isolate=full"]));
      scratchIds.add(scratch.handle.id);
      expect(scratch.detached).toBe(true);
      await rm(cache, { recursive: true, force: true });
      const listed = Schema.decodeUnknownSync(Schema.Array(scratchSummary))(await cli(["scratch:list"]));
      for (const entry of listed) scratchIds.add(entry.id);
      expect(listed.map((entry) => entry.id)).toEqual([scratch.handle.id]);
      const info = Schema.decodeUnknownSync(
        Schema.Struct({
          ...scratchSummary.fields,
          endpoints: Schema.Array(Schema.Struct({ service: Schema.String })),
        }),
      )(await cli(["scratch:info", scratch.handle.id]));
      expect(info.id).toBe(scratch.handle.id);
      expect(info.endpoints.map((entry) => entry.service)).toEqual(["web"]);
      await cli(["scratch:destroy", scratch.handle.id, "--yes"]);
      scratchIds.delete(scratch.handle.id);
      expect(Schema.decodeUnknownSync(Schema.Array(scratchSummary))(await cli(["scratch:list"]))).toEqual([]);
    } finally {
      console.log("CACHE_WIPE_CLEANUP_PENDING", JSON.stringify({ name, root, scratchIds: [...scratchIds] }));
      try {
        const results = await Promise.allSettled([
          ...[...scratchIds].map((id) => lando(["scratch:destroy", id, "--yes"])),
          lando(["destroy", "--yes", "--volumes"]),
        ]);
        console.log("CACHE_WIPE_CLEANUP_RESULT", JSON.stringify({ name, root, results }));
        for (const result of results) {
          expect(result.status, JSON.stringify(result)).toBe("fulfilled");
          switch (result.status) {
            case "fulfilled":
              expect(result.value.exitCode, JSON.stringify(result.value)).toBe(0);
              break;
            case "rejected":
              break;
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  13 * childTimeout + 60_000,
);
