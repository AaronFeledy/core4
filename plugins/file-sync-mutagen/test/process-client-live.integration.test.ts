import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { service as runner } from "@lando/engine/services/process-runner";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { layer as downloaderLayer } from "@lando/http-client/downloader";
import { layer as httpLayer } from "@lando/http-client/live";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { AbsolutePath, AppId, type FileSyncSessionSpec, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect, Exit, Layer, Schema } from "effect";
import { makeMutagenProcessClient } from "../src/mutagen-process-client.ts";
import { provisionMutagen } from "../src/provision.ts";
import { privateFileAccess } from "./support/mutagen-process.ts";

const liveSocket = resolveLiveProviderSocket();
const dockerCliPath = Bun.which("docker");
const prerequisites =
  process.platform === "linux" && liveSocket !== undefined && dockerCliPath !== null
    ? { dockerCliPath, dockerHost: `unix://${liveSocket.socketPath}` }
    : undefined;
const timeout = 120_000;
const hostContent = "from the local source\n";
const race =
  "Error: unable to connect to beta: unable to connect to endpoint: unable to dial agent endpoint: unable to message prompter: prompter not found";
type Mode = "race" | "race-after-create" | "race-after-foreign" | "real";
const liveTest = (name: string, run: () => Promise<void>) => test(name, run, timeout);

const command = async (cmd: string[], env: Record<string, string>) => {
  const child = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout.text(),
    child.stderr.text(),
  ]);
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${exitCode}: ${stderr}`);
  return stdout;
};

describe.skipIf(prerequisites === undefined)("Mutagen process client against a live daemon", () => {
  const resource = `lando-mutagen-${crypto.randomUUID()}`;
  const container = `${resource}-helper`;
  const volume = `${resource}-data`;
  const cleanup: Array<() => Promise<unknown>> = [];
  let root: string | undefined;

  const docker = (...args: string[]) => {
    if (prerequisites === undefined) throw new Error("Live Docker CLI and Podman socket required.");
    return command([prerequisites.dockerCliPath, ...args], {
      DOCKER_HOST: prerequisites.dockerHost,
      DOCKER_CONTEXT: "",
    });
  };

  beforeAll(async () => {
    // Mutagen adds /daemon/daemon.sock under the data directory; Unix socket paths have a short limit.
    const dir = await mkdtemp("/tmp/lms-");
    root = dir;
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await Effect.runPromise(
      provisionMutagen({ binDir: join(root, "bin"), toolDownloadsDir: join(root, "downloads") }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provide(downloaderLayer, httpLayer)),
      ),
    );
    await docker("volume", "create", volume);
    cleanup.push(() => docker("volume", "rm", volume));
    const cidFile = join(dir, "helper.cid");
    cleanup.push(async () => {
      if (existsSync(cidFile)) await docker("rm", "--force", container);
    });
    const args = ["run", "-d", "--cidfile", cidFile, "--name", container, "-v", `${volume}:/data`];
    await docker(...args, "docker.io/library/alpine:3.21", "sleep", "infinity");
  }, timeout);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const release of cleanup.toReversed()) {
      const [result] = await Promise.allSettled([release()]);
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Live Mutagen fixture cleanup failed");
  }, timeout);

  const fixture = async (id: string, modes?: readonly Mode[]) => {
    if (root === undefined || prerequisites === undefined) throw new Error("Live Mutagen setup did not run.");
    const dir = join(root, id);
    const binDir = join(root, "bin");
    const binary = join(binDir, "mutagen");
    const dataDir = join(dir, "data");
    cleanup.push(async () => {
      if (existsSync(join(dataDir, "daemon", "daemon.sock"))) {
        await command([binary, "daemon", "stop"], { MUTAGEN_DATA_DIRECTORY: dataDir });
      }
    });
    const source = AbsolutePath.make(join(dir, "source"));
    const path = PortablePath.make(`/data/${id}`);
    const name = `live-${id}`;
    const foreign = `foreign-${id}`;
    const spec: FileSyncSessionSpec = {
      app: { kind: "user", id: AppId.make(name), root: source },
      service: ServiceName.make("web"),
      mountKey: "app-root",
      source,
      target: { _tag: "volume", name: volume, path },
      mode: "two-way-safe",
      excludes: [".git"],
    };
    await mkdir(source, { recursive: true });
    await mkdir(dataDir);
    await Bun.write(join(source, "host.txt"), hostContent);
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make(join(dir, "state")),
      privateFileAccess,
    );
    const options = {
      ...prerequisites,
      dataDir,
      runner,
      stateStore,
      resolveTarget: () => Effect.succeed({ containerId: container, path }),
    };
    const plain = makeMutagenProcessClient({ ...options, binDir });
    const log = join(dir, "attempts");
    const foreignCreated = join(dir, "foreign-created");
    const wrapperDir = join(dir, "wrapper");
    if (modes !== undefined) {
      const queue = join(dir, "queue");
      await mkdir(wrapperDir);
      await Bun.write(queue, `${modes.join("\n")}\n`);
      await writeFile(
        join(wrapperDir, "mutagen"),
        `#!/bin/bash
set -euo pipefail
if [[ \${1:-} == sync && \${2:-} == create ]]; then
  mapfile -t modes < '${queue}'
  mode=\${modes[0]:-real}
  printf '%s\n' "\${modes[@]:1}" > '${queue}'
  printf '%s\n' "$mode" >> '${log}'
  case "$mode" in
    real) exec '${binary}' "$@" ;;
    race) ;;
    race-after-create) '${binary}' "$@" >/dev/null ;;
    race-after-foreign)
      '${binary}' sync create --no-global-configuration --name '${foreign}' --mode two-way-safe '${source}' 'docker://${container}/data/${foreign}' >/dev/null
      touch '${foreignCreated}'
      ;;
    *) exit 2 ;;
  esac
  printf '%s\n' '${race}' >&2
  exit 1
fi
exec '${binary}' "$@"
`,
        { mode: 0o700 },
      );
    }
    const client =
      modes === undefined
        ? plain
        : makeMutagenProcessClient({ ...options, binDir: wrapperDir, verifyInstalled: async () => true });
    const ledger = stateStore.open({
      namespace: "sessions",
      key: "mutagen.json",
      schema: Schema.Unknown,
      version: 1,
      codec: "json",
    });
    return {
      input: { name, spec },
      client,
      plain,
      expectPhase: async (phase: "preparing" | "committed") => {
        const stored = await Effect.runPromise(Effect.flatMap(ledger, (bucket) => bucket.get));
        expect(stored).toMatchObject({ sessions: [{ name, phase }] });
      },
      attempts: async () => (await Bun.file(log).text()).trimEnd().split("\n").length,
      readHostFileInContainer: () => docker("exec", container, "cat", `${path}/host.txt`),
      terminateForeign: async () => {
        if (await Bun.file(foreignCreated).exists()) {
          await command([binary, "sync", "terminate", foreign], { MUTAGEN_DATA_DIRECTORY: dataDir });
        }
      },
    };
  };

  liveTest("creates and flushes in both directions, then pauses, resumes and terminates", async () => {
    const { client, input, readHostFileInContainer } = await fixture("lifecycle");
    const { name, spec } = input;
    await Effect.runPromise(client.create(input));
    expect(await readHostFileInContainer()).toBe(hostContent);
    const containerContent = "from the container\n";
    const shell = ["sh", "-c", 'printf "%s" "$1" > "$2"', "sh"];
    await docker("exec", container, ...shell, containerContent, `${spec.target.path}/container.txt`);
    await Effect.runPromise(client.flush(name));
    expect(await Bun.file(join(spec.source, "container.txt")).text()).toBe(containerContent);
    await Effect.runPromise(client.pause(name));
    expect(await Effect.runPromise(client.list)).toMatchObject([{ name, status: "paused" }]);
    await Effect.runPromise(client.resume(name));
    await Effect.runPromise(client.flush(name));
    expect(await Effect.runPromise(client.list)).toMatchObject([{ name, status: "running" }]);
    await Effect.runPromise(client.terminate(name));
    expect(await Effect.runPromise(client.list)).toEqual([]);
  });

  const successCases = [
    {
      title: "retries once when the race leaves no daemon session",
      id: "retry",
      modes: ["race", "real"],
      count: 2,
    },
    {
      title: "adopts the saved session when create reports a race after daemon persistence",
      id: "adoption",
      modes: ["race-after-create"],
      count: 1,
    },
  ] as const;
  for (const { title, id, modes, count } of successCases) {
    liveTest(title, async () => {
      const { client, input, expectPhase, attempts, readHostFileInContainer } = await fixture(id, modes);
      await Effect.runPromise(client.create(input));
      expect(await attempts()).toBe(count);
      await expectPhase("committed");
      expect(await readHostFileInContainer()).toBe(hostContent);
    });
  }

  const expectRaceFailure = async (create: Effect.Effect<void, unknown>) => {
    const exit = await Effect.runPromiseExit(create);
    if (!Exit.isFailure(exit)) throw new Error("Expected create to fail after the injected race.");
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "FileSyncStartError" },
      additionalErrors: [{ role: "peer", error: { _tag: "FileSyncStartError" } }],
    });
  };

  liveTest(
    "keeps both race failures and lets a later plain create recover the preparing receipt",
    async () => {
      const { client, plain, input, expectPhase, attempts, readHostFileInContainer } = await fixture(
        "recovery",
        ["race", "race"],
      );
      await expectRaceFailure(client.create(input));
      expect(await attempts()).toBe(2);
      await expectPhase("preparing");
      await Effect.runPromise(plain.create(input));
      await expectPhase("committed");
      expect(await readHostFileInContainer()).toBe(hostContent);
    },
  );

  liveTest("does not retry when a raced create leaves a foreign session on the same source", async () => {
    const { client, input, expectPhase, attempts, terminateForeign } = await fixture("collision", [
      "race-after-foreign",
    ]);
    try {
      await expectRaceFailure(client.create(input));
      expect(await attempts()).toBe(1);
      await expectPhase("preparing");
    } finally {
      await terminateForeign();
    }
  });
});
