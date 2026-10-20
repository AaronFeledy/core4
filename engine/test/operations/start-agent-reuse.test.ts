import { expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import { ProcessRunner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { startApp } from "../../src/operations/start.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/gpg-agent/intent.ts";
import * as worker from "../../src/subsystems/ssh-agent/detached-worker.ts";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/ssh/intent.ts";
import { relayHarness } from "../subsystems/ssh-agent/reuse-harness.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test.each(["ssh", "gpg"] as const)(
  "two starts and selected-service rebuild reuse the %s worker",
  async (kind) => {
    // Given
    const relay = await relayHarness(kind, "bind-directory");
    const socketPath = join(relay.root, "upstream.sock");
    const server = createServer((socket) => {
      if (kind === "gpg") socket.write("OK ready\n");
      socket.on("data", () =>
        socket.write(kind === "gpg" ? "OK\n" : Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0])),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const extension = kind === "ssh" ? SSH_AGENT_PLAN_EXTENSION_KEY : GPG_AGENT_PLAN_EXTENSION_KEY;
    const intent = kind === "ssh" ? { mode: "host" } : { forward: true };
    const selected: AppPlan = {
      ...plan,
      root: AbsolutePath.make(relay.root),
      extensions: { [extension]: intent },
      services: { [web.name]: { ...web, extensions: { [extension]: intent } } },
    };
    const calls: string[] = [];
    const applied: AppPlan[] = [];
    let generation = 0;
    let failExport = false;
    const exports: number[] = [];
    const harness = makeHarness({
      plannedApp: selected,
      onApply: (value) => {
        applied.push(value);
        calls.push("apply");
      },
      exec: () =>
        Effect.sync(() => {
          calls.push("prepare");
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    });
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
    const original = worker.startDetachedAgentRelayWorker;
    const startWorker = spyOn(worker, "startDetachedAgentRelayWorker").mockImplementation((options) =>
      original({
        ...options,
        spawnWorker: relay.options.spawnWorker,
        isAlive: relay.options.isAlive,
        identify: relay.options.identify,
        terminateProcess: relay.options.terminateProcess,
      }),
    );
    const registered: string[] = [];
    const redaction = makeRedactionService({
      id: "test",
      list: Effect.succeed([]),
      get: () => Effect.succeed("unused"),
      has: () => Effect.succeed(false),
    });
    const target = {
      plan: selected,
      root: selected.root,
      app: { kind: "user" as const, id: selected.id, root: selected.root },
      landofile: {
        name: selected.name,
        services: {},
        sshAgent: { sidecar: false, socket: socketPath },
        gpgAgent: { forward: kind === "gpg", socket: socketPath },
      },
    };
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          select: () =>
            Effect.succeed({
              ...provider,
              capabilities: { ...provider.capabilities, agentSocket: { delivery: "bind-directory" } },
            }),
        }),
        Effect.provideService(ProcessRunner, {
          run: () => Effect.succeed({ exitCode: 0, stdout: socketPath, stderr: "" }),
          stream: () => Stream.empty,
          streamWithExit: () => {
            exports.push(generation);
            return Stream.make(
              { kind: "stdout" as const, chunk: new TextEncoder().encode(`keys-${generation}`) },
              { exitCode: failExport ? 2 : 0 },
            );
          },
        }),
        Effect.provideService(RedactionService, {
          ...redaction,
          registerValues: (values) =>
            redaction.registerValues(values).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  registered.push(...values);
                }),
              ),
            ),
        }),
        Effect.provide(harness.layer),
      );
    try {
      await Effect.runPromise(run(startApp({}, target)));
      const first = relay.state.ready;
      generation++;
      // When
      await Effect.runPromise(run(startApp({}, target)));
      generation++;
      await Effect.runPromise(run(rebuildApp({ services: [web.name] }, target)));
      // Then
      expect(relay.state.spawned).toBe(1);
      expect(relay.state.terminated).toBe(0);
      expect(relay.state.ready).toBe(first);
      expect(applied).toHaveLength(3);
      expect(registered).toEqual(["secret-1", "secret-1", "secret-1"]);
      expect(JSON.stringify(harness.events)).not.toContain("secret-1");
      if (kind === "gpg") {
        expect(exports).toEqual([0, 0, 1, 1, 2, 2]);
        expect(calls).toEqual(["apply", "prepare", "apply", "prepare", "apply", "prepare"]);
        const keyring = join(
          makeLandoPaths({ userDataRoot: harness.userDataRoot }).agentRelayRunDir(
            "gpg",
            selected.id,
            selected.root,
          ),
          "keyring",
        );
        expect(await readFile(join(keyring, "pubring.gpg"), "utf8")).toBe("keys-2");
        expect(await readFile(join(keyring, "otrust.txt"), "utf8")).toBe("keys-2");
        failExport = true;
        const failure = await Effect.runPromise(run(startApp({}, target).pipe(Effect.result)));
        expect(failure).toMatchObject({ _tag: "Failure", failure: { _tag: "GpgAgentUnavailableError" } });
        expect(relay.state.spawned).toBe(1);
        expect(relay.state.terminated).toBe(1);
      }
    } finally {
      startWorker.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await relay.cleanup();
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
