import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { makeDockerApiClient } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ContainerHelperDigest,
  ProviderId,
  ServiceName,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk } from "@lando/sdk/services";
import { Cause, DateTime, Deferred, Effect, type Exit, Fiber, Stream } from "effect";
import { makeRuntimeProvider } from "./provider-fixture.ts";

const host = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const docker = async (args: readonly string[]) => {
  if (host === undefined) throw new Error("Explicit live Docker socket required");
  const process = Bun.spawn(["docker", "--host", host.startsWith("/") ? `unix://${host}` : host, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [code, out, err] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Disposable Docker fixture failed (${code}): ${err}`);
  return out.trim();
};
const fixture = async (
  user?: string,
  create = true,
  watchOptions: { readonly endInputAfter?: number } = {},
) => {
  const name = `cancel-${crypto.randomUUID()}`;
  const id = AppId.make(name);
  const service = ServiceName.make("web");
  const providerId = ProviderId.make("docker");
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-10-28T00:00:00Z"),
    source: "exec-cancellation-live",
    runtime: 4 as const,
  };
  const plan: AppPlan = {
    id,
    valueModel: 1,
    name,
    slug: name,
    root: AbsolutePath.make(`/tmp/${name}`),
    provider: providerId,
    networking: landoNetworkingPlan({ slug: name, serviceNames: [service], sharedCrossAppNetwork: false }),
    services: {
      [service]: {
        name: service,
        type: "node",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref", ref: "alpine:3.20" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const container = serviceContainerName(plan, service);
  if (create) {
    await docker(["create", "--name", container, "alpine:3.20", "sleep", "300"]);
    await docker(["start", container]);
  }
  try {
    const api = makeDockerApiClient(host ?? "");
    const request = api.request;
    const stream = api.stream;
    if (request === undefined || stream === undefined) throw new Error("Missing live Docker transport");
    const requests: EngineHttpRequest[] = [];
    const watchIds = new Set<string>();
    const primaryIds = new Set<string>();
    const watchPulses: number[] = [];
    const observedApi = {
      ...api,
      request: (input: EngineHttpRequest) =>
        Effect.gen(function* () {
          requests.push(input);
          const response = yield* request(input);
          const cmd = (input.body as { Cmd?: readonly string[] } | undefined)?.Cmd;
          if (input.method === "POST" && input.path.endsWith("/exec") && response.status === 201) {
            const id = (JSON.parse(response.body) as { Id: string }).Id;
            if (cmd?.[1] === "exec-control" && cmd[4] === "watch") watchIds.add(id);
            if (cmd?.[1] === "exec-supervisor") primaryIds.add(id);
          }
          return response;
        }),
      stream: (input: EngineHttpRequest) => {
        const match = /^\/exec\/([^/]+)\/start$/u.exec(input.path);
        if (
          match?.[1] === undefined ||
          !watchIds.has(decodeURIComponent(match[1])) ||
          input.stdin === undefined
        )
          return stream(input);
        const source = input.stdin;
        return stream({
          ...input,
          stdin: {
            async *[Symbol.asyncIterator]() {
              for await (const bytes of source) {
                watchPulses.push((JSON.parse(new TextDecoder().decode(bytes)) as { seq: number }).seq);
                yield bytes;
                if (
                  watchOptions.endInputAfter !== undefined &&
                  watchPulses.length >= watchOptions.endInputAfter
                )
                  return;
              }
            },
          },
        });
      },
    };
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        dockerApi: observedApi,
        resolveContainerHelper: (target) =>
          Effect.tryPromise({
            try: async () => {
              const path = resolve(
                import.meta.dir,
                `../../../core/container-helper/dist/linux-${target.arch}/lando-container-helper`,
              );
              const bytes = await readFile(path);
              return {
                target,
                path: AbsolutePath.make(path),
                digest: ContainerHelperDigest.make(createHash("sha256").update(bytes).digest("hex")),
              };
            },
            catch: (cause) => {
              throw cause;
            },
          }),
      }),
    );
    const target = { app: id, service, plan, ...(user === undefined ? {} : { user }) };
    return {
      provider,
      target,
      container,
      requests,
      watchPulses,
      watchIds,
      primaryIds,
      inspectExec: (id: string) =>
        Effect.runPromise(request({ method: "GET", path: `/exec/${encodeURIComponent(id)}/json` })).then(
          (response) => JSON.parse(response.body) as { Running?: boolean; ExitCode?: number },
        ),
      close: () =>
        create
          ? docker(["rm", "--force", container])
          : Effect.runPromise(provider.destroy({ app: id }, { volumes: true })),
      inside: (args: readonly string[]) => docker(["exec", container, ...args]),
      asUser: (args: readonly string[]) =>
        docker(["exec", ...(user === undefined ? [] : ["--user", user]), container, ...args]),
    };
  } catch (error) {
    if (create) await docker(["rm", "--force", container]);
    throw error;
  }
};
const bytesOf = (chunks: readonly ExecChunk[]) => {
  const bytes: number[] = [];
  for (const chunk of chunks)
    if (!("exitCode" in chunk) && chunk.kind === "stdout") bytes.push(...chunk.chunk);
  return bytes;
};

const assertInterrupted = (exit: Exit.Exit<unknown, unknown>) => {
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
};

describe("Docker supervised non-TTY execution", () => {
  test.skipIf(host === undefined)(
    "provider apply supervises authored dependency healthchecks",
    async () => {
      const f = await fixture(undefined, false);
      const base = f.target.plan.services[f.target.service];
      if (base === undefined) throw new Error("Missing healthcheck fixture service");
      const db = ServiceName.make("db");
      const plan: AppPlan = {
        ...f.target.plan,
        services: {
          [db]: {
            ...base,
            name: db,
            primary: false,
            command: ["sleep", "300"],
            healthcheck: {
              kind: "command",
              command: ["sh", "-c", "printf healthy >/tmp/health-observed"],
              intervalSeconds: 60,
              timeoutSeconds: 5,
              retries: 1,
            },
          },
          [f.target.service]: {
            ...base,
            command: ["sleep", "300"],
            dependsOn: [{ service: db, condition: "service_healthy", required: true }],
          },
        },
      };
      try {
        await Effect.runPromise(Effect.scoped(f.provider.apply(plan, { reconcile: true })));
        const container = serviceContainerName(plan, db);
        expect(await docker(["exec", container, "cat", "/tmp/health-observed"])).toBe("healthy");
        expect(
          await docker(["exec", container, "sh", "-c", "find /tmp -maxdepth 1 -name 'lando-exec-*' | wc -l"]),
        ).toBe("1");
        expect(await docker(["inspect", "--format", "{{.State.Running}}", f.container])).toBe("true");
      } finally {
        await Effect.runPromise(f.provider.destroy({ app: plan.id, plan }, { volumes: true }));
      }
    },
    60_000,
  );

  for (const user of [undefined, "1000:1000"]) {
    test.skipIf(host === undefined)(
      `one watch sustains a quiet command beyond the lease (${user ?? "root"})`,
      async () => {
        const f = await fixture(user);
        try {
          const chunks: ExecChunk[] = [];
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const ready = yield* Deferred.make<void>();
                const fiber = yield* Stream.runForEach(
                  f.provider.execStream(f.target, {
                    command: ["sh", "-c", "echo ready; sleep 12; printf done"],
                  }),
                  (chunk) =>
                    Effect.gen(function* () {
                      chunks.push(chunk);
                      if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready"))
                        yield* Deferred.succeed(ready, undefined);
                    }),
                ).pipe(Effect.forkScoped);
                yield* Deferred.await(ready);
                const before = f.requests.filter(
                  (input) => input.method === "POST" && input.path.endsWith("/exec"),
                ).length;
                const pulseCount = f.watchPulses.length;
                yield* Effect.sleep("6 seconds");
                expect(
                  f.requests.filter((input) => input.method === "POST" && input.path.endsWith("/exec"))
                    .length,
                ).toBe(before);
                expect(f.watchPulses.length - pulseCount).toBeGreaterThanOrEqual(8);
                yield* Fiber.join(fiber);
              }),
            ),
          );
          expect(new TextDecoder().decode(new Uint8Array(bytesOf(chunks)))).toBe("ready\ndone");
          expect(chunks.filter((chunk) => "exitCode" in chunk)).toEqual([{ exitCode: 0 }]);
          expect(f.watchIds.size).toBe(1);
          expect(
            f.requests.filter(
              (input) => (input.body as { Cmd?: readonly string[] } | undefined)?.Cmd?.[4] === "status",
            ),
          ).toHaveLength(0);
          for (const id of [...f.watchIds, ...f.primaryIds])
            expect(await f.inspectExec(id)).toMatchObject({ Running: false, ExitCode: 0 });
        } finally {
          await f.close();
        }
      },
      40_000,
    );
  }
  test.skipIf(host === undefined)(
    "a non-root command emits zero payload while watch heartbeats sustain it beyond the lease",
    async () => {
      const f = await fixture("1000:1000");
      try {
        const result = await Effect.runPromise(f.provider.exec(f.target, { command: ["sleep", "12"] }));
        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(f.watchIds.size).toBe(1);
        for (const id of [...f.watchIds, ...f.primaryIds])
          expect(await f.inspectExec(id)).toMatchObject({ Running: false, ExitCode: 0 });
      } finally {
        await f.close();
      }
    },
    40_000,
  );
  test.skipIf(host === undefined)(
    "lost watch input is drained and cannot leave the payload or supervisor alive",
    async () => {
      const f = await fixture("1000:1000", true, { endInputAfter: 3 });
      try {
        const chunks: ExecChunk[] = [];
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Stream.runForEach(
              f.provider.execStream(f.target, {
                command: ["sh", "-c", "echo $$ >/tmp/watch-loss-pid; echo ready; sleep 60"],
              }),
              (chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk);
                }),
            ),
          ),
        );
        expect(exit._tag).toBe("Failure");
        expect(chunks.some((chunk) => "exitCode" in chunk)).toBe(false);
        expect(new TextDecoder().decode(new Uint8Array(bytesOf(chunks)))).toBe("ready\n");
        expect(f.watchPulses).toEqual([1, 2, 3]);
        expect(f.watchIds.size).toBe(1);
        expect(f.primaryIds.size).toBe(1);
        for (const id of f.watchIds)
          expect(await f.inspectExec(id)).toMatchObject({ Running: false, ExitCode: 0 });
        for (const id of f.primaryIds) expect((await f.inspectExec(id)).Running).toBe(false);
        await f.inside(["sh", "-c", "test ! -e /proc/$(cat /tmp/watch-loss-pid)"]);
        expect(
          (await f.inside(["ps", "-o", "args"]))
            .split("\n")
            .filter(
              (line) => line.startsWith("/tmp/lando-exec-") && line.includes("lando-container-helper exec-"),
            ),
        ).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );
  for (const user of [undefined, "1000:1000"]) {
    test.skipIf(host === undefined)(
      `preserves raw stdin, EOF and nonzero status (${user ?? "root"})`,
      async () => {
        const f = await fixture(user);
        try {
          const payload = new Uint8Array([0, 255, 195, 169, 10, 1, 0]);
          const command: CommandSpec = {
            command: ["sh", "-c", "cat; exit 23"],
            stdinStream: {
              async *[Symbol.asyncIterator]() {
                yield payload;
              },
            },
          };
          const chunks = await Effect.runPromise(
            Effect.scoped(Stream.runCollect(f.provider.execStream(f.target, command))),
          );
          expect(bytesOf(chunks)).toEqual([...payload]);
          expect(chunks.filter((chunk) => "exitCode" in chunk)).toEqual([{ exitCode: 23 }]);
          expect(
            await f.inside(["sh", "-c", "find /tmp -maxdepth 1 -name 'lando-exec-session-*' | wc -l"]),
          ).toBe("0");
        } finally {
          await f.close();
        }
      },
      30_000,
    );
    test.skipIf(host === undefined)(
      `cancels INT with escaped descendants and leaves unrelated sentinel (${user ?? "root"})`,
      async () => {
        const f = await fixture(user);
        try {
          await f.asUser(["sh", "-c", "sleep 317 >/dev/null 2>&1 & echo $! >/tmp/sentinel"]);
          const abort = new AbortController();
          let ready = false;
          const terminals: number[] = [];
          const result = Effect.runPromiseExit(
            Effect.scoped(
              Stream.runForEach(
                f.provider.execStream(f.target, {
                  command: [
                    "sh",
                    "-c",
                    "trap '' INT; setsid sh -c 'sh -c \"nc -lk -p 31337 -e cat </dev/null >/dev/null 2>&1 &\"'; while ! nc -z 127.0.0.1 31337; do sleep 0.05; done; echo ready; while :; do sleep 313; done",
                  ],
                  signal: abort.signal,
                }),
                (chunk) =>
                  Effect.sync(() => {
                    if ("exitCode" in chunk) terminals.push(chunk.exitCode);
                    if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready")) {
                      ready = true;
                      abort.abort("SIGINT");
                    }
                  }),
              ),
            ),
          );
          assertInterrupted(await result);
          expect(terminals).toEqual([]);
          expect(ready).toBe(true);
          expect(
            await f.inside([
              "sh",
              "-c",
              "kill -0 $(cat /tmp/sentinel) || exit 1; ps -o args | sed -n '/^sleep 313$/p'",
            ]),
          ).toBe("");
          expect(
            await f.inside(["sh", "-c", "find /tmp -maxdepth 1 -name 'lando-exec-session-*' | wc -l"]),
          ).toBe("0");
          const rebound = await Effect.runPromise(
            f.provider.exec(f.target, {
              command: [
                "sh",
                "-c",
                "nc -l -p 31337 >/dev/null 2>&1 & pid=$!; sleep 0.1; kill -0 $pid || exit 1; kill $pid; wait $pid; exit 0",
              ],
            }),
          );
          expect(rebound.exitCode).toBe(0);
        } finally {
          await f.close();
        }
      },
      30_000,
    );
  }
  for (const user of [undefined, "1000:1000"]) {
    test.skipIf(host === undefined)(
      `scope interruption joins the tree and releases its port (${user ?? "root"})`,
      async () => {
        const f = await fixture(user);
        try {
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const ready = yield* Deferred.make<void>();
                const fiber = yield* Stream.runForEach(
                  f.provider.execStream(f.target, {
                    command: [
                      "sh",
                      "-c",
                      "nc -lk -p 31337 -e cat >/dev/null 2>&1 & while ! nc -z 127.0.0.1 31337; do sleep 0.05; done; echo ready; wait",
                    ],
                  }),
                  (chunk) =>
                    !("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready")
                      ? Deferred.succeed(ready, undefined)
                      : Effect.void,
                ).pipe(Effect.forkScoped);
                yield* Deferred.await(ready);
                yield* Fiber.interrupt(fiber);
              }),
            ),
          );
          const result = await Effect.runPromise(
            f.provider.exec(f.target, {
              command: [
                "sh",
                "-c",
                "nc -l -p 31337 >/dev/null 2>&1 & pid=$!; sleep 0.1; kill -0 $pid || exit 1; kill $pid; wait $pid; exit 0",
              ],
            }),
          );
          expect(result.exitCode).toBe(0);
        } finally {
          await f.close();
        }
      },
      30_000,
    );
  }
  test.skipIf(host === undefined)(
    "forwards explicit TERM and never launches a pre-aborted command",
    async () => {
      const f = await fixture();
      try {
        const pre = new AbortController();
        pre.abort("SIGTERM");
        await expect(
          Effect.runPromise(
            f.provider.exec(f.target, { command: ["touch", "/tmp/pre-abort-launched"], signal: pre.signal }),
          ),
        ).rejects.toBeDefined();
        expect(await f.inside(["sh", "-c", "test ! -e /tmp/pre-abort-launched && echo absent"])).toBe(
          "absent",
        );
        const abort = new AbortController();
        const terminals: number[] = [];
        const terminated = await Effect.runPromiseExit(
          Effect.scoped(
            Stream.runForEach(
              f.provider.execStream(f.target, {
                command: [
                  "sh",
                  "-c",
                  "trap 'echo term >/tmp/observed-signal; exit 143' TERM; echo ready; while :; do sleep 1; done",
                ],
                signal: abort.signal,
              }),
              (chunk) =>
                Effect.sync(() => {
                  if ("exitCode" in chunk) terminals.push(chunk.exitCode);
                  if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready"))
                    abort.abort("SIGTERM");
                }),
            ),
          ),
        );
        assertInterrupted(terminated);
        expect(terminals).toEqual([]);
        expect(await f.inside(["cat", "/tmp/observed-signal"])).toBe("term");
      } finally {
        await f.close();
      }
    },
    30_000,
  );
  test.skipIf(host === undefined)(
    "high-output cancellation preserves attachment until INT reaches the command",
    async () => {
      const f = await fixture();
      try {
        const abort = new AbortController();
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const first = yield* Deferred.make<void>();
              let delaying = true;
              const running = yield* Stream.runForEach(
                f.provider.execStream(f.target, {
                  command: [
                    "sh",
                    "-c",
                    "trap 'printf INT >/tmp/high-signal; exit 42' INT; trap 'printf PIPE >/tmp/high-signal; exit 9' PIPE; while :; do printf '%8192d' 0; done",
                  ],
                  signal: abort.signal,
                }),
                (chunk) => {
                  if ("exitCode" in chunk || !delaying) return Effect.void;
                  delaying = false;
                  return Deferred.succeed(first, undefined).pipe(
                    Effect.andThen(Effect.sleep("500 millis")),
                    Effect.asVoid,
                  );
                },
              ).pipe(Effect.forkScoped);
              yield* Deferred.await(first);
              yield* Effect.sleep("100 millis");
              abort.abort("SIGINT");
              yield* Fiber.join(running);
            }),
          ),
        );
        assertInterrupted(exit);
        expect(await f.inside(["cat", "/tmp/high-signal"])).toBe("INT");
      } finally {
        await f.close();
      }
    },
    30_000,
  );
  test.skipIf(host === undefined)(
    "concurrent command cancellation preserves its peer and releases both ports",
    async () => {
      const f = await fixture();
      try {
        const first = new AbortController();
        const second = new AbortController();
        const start = (port: number, abort: AbortController) => {
          let ready: () => void = () => undefined;
          const started = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const completed = Effect.runPromiseExit(
            Effect.scoped(
              Stream.runForEach(
                f.provider.execStream(f.target, {
                  command: [
                    "sh",
                    "-c",
                    `nc -lk -p ${port} -e cat >/dev/null 2>&1 & while ! nc -z 127.0.0.1 ${port}; do sleep 0.05; done; echo ready; wait`,
                  ],
                  signal: abort.signal,
                }),
                (chunk) =>
                  Effect.sync(() => {
                    if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready"))
                      ready();
                  }),
              ),
            ),
          );
          return { started, completed };
        };
        const a = start(31337, first);
        const b = start(31338, second);
        await Promise.all([a.started, b.started]);
        first.abort("SIGTERM");
        assertInterrupted(await a.completed);
        expect(await f.inside(["sh", "-c", "nc -z 127.0.0.1 31338 && echo peer-alive"])).toBe("peer-alive");
        second.abort();
        assertInterrupted(await b.completed);
        const result = await Effect.runPromise(
          f.provider.exec(f.target, {
            command: [
              "sh",
              "-c",
              "nc -l -p 31337 >/dev/null 2>&1 & a=$!; nc -l -p 31338 >/dev/null 2>&1 & b=$!; sleep 0.1; kill -0 $a $b || exit 1; kill $a $b; wait; exit 0",
            ],
          }),
        );
        expect(result.exitCode).toBe(0);
      } finally {
        await f.close();
      }
    },
    40_000,
  );
  test.skipIf(host === undefined)(
    "natural main exit joins background descendants and retains status",
    async () => {
      const f = await fixture();
      try {
        const result = await Effect.runPromise(
          f.provider.exec(f.target, { command: ["sh", "-c", "setsid sleep 313 >/dev/null 2>&1 & exit 29"] }),
        );
        expect(result.exitCode).toBe(29);
        expect(await f.inside(["sh", "-c", "ps -o args | sed -n '/^sleep 313$/p'"])).toBe("");
      } finally {
        await f.close();
      }
    },
    30_000,
  );
});
