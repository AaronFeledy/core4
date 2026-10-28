import { describe, expect, test } from "bun:test";
import { ContainerHelperUnavailableError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Exit, Option, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { execStream } from "../src/podman/exec.ts";
import { installSupervisedExecFixture, supervisedExecFixtureOptions } from "./support/exec-supervision.ts";

const ctx = { providerId: "docker", remediation: "Retry.", env: {} };
const service = ServiceName.make("web");
const app = AppId.make("supervision-races");
const provider = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
  source: "exec-supervision.test.ts",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: app,
  name: "Supervision races",
  slug: "supervision-races",
  root: AbsolutePath.make("/tmp/supervision-races"),
  provider,
  services: {
    [service]: {
      name: service,
      type: "node",
      provider,
      primary: true,
      artifact: { kind: "ref", ref: "node:22-alpine" },
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
const target = { app, service, user: "1000:1000" };
const providerFailure = (message: string) =>
  new ProviderUnavailableError({ ...ctx, operation: "exec", message });
const frame = (value: string) => {
  const payload = new TextEncoder().encode(value);
  const result = new Uint8Array(payload.length + 8);
  result[0] = 1;
  new DataView(result.buffer).setUint32(4, payload.length);
  result.set(payload, 8);
  return result;
};
type Stage =
  | "init-create"
  | "init-start"
  | "primary-create"
  | "primary-start"
  | "ready"
  | "launch"
  | "status"
  | "cancel"
  | "collect"
  | "cleanup";
interface Hooks {
  readonly before?: (stage: Stage, input: EngineHttpRequest) => Effect.Effect<void, ProviderUnavailableError>;
  readonly replaceStream?: (
    stage: Stage,
    input: EngineHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError> | undefined;
  readonly mainError?: ProviderUnavailableError;
  readonly exitCode?: number;
}
const fixture = (hooks: Hooks = {}) => {
  const requests: EngineHttpRequest[] = [];
  const events: Stage[] = [];
  const commands = new Map<string, readonly string[]>();
  let primaryStarts = 0;
  let launches = 0;
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.sync(() => {
        if (input.method === "GET" && input.path.startsWith("/containers/") && input.path.endsWith("/json"))
          return { status: 200, body: JSON.stringify({ Id: "immutable-container-id" }) };
        if (input.method === "POST" && input.path.endsWith("/exec"))
          return { status: 201, body: JSON.stringify({ Id: "primary-exec-id" }) };
        if (input.path === "/exec/primary-exec-id/json")
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: hooks.exitCode ?? 0 }) };
        return { status: 500, body: "unexpected fake engine request" };
      }),
    stream: (input) =>
      Stream.suspend(() => {
        input.onResponseHead?.();
        return hooks.mainError === undefined
          ? Stream.make(frame("command output\n"))
          : Stream.fail(hooks.mainError);
      }),
  };
  installSupervisedExecFixture(api);
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined) throw new TypeError("Missing fixture transport.");
  const stageFor = (cmd: readonly string[] | undefined, starting: boolean): Stage | undefined => {
    if (cmd?.[1] === "exec-init") return starting ? "init-start" : "init-create";
    if (cmd?.[1] === "exec-supervisor") return starting ? "primary-start" : "primary-create";
    if (cmd?.[1] === "exec-cleanup") return starting ? "cleanup" : undefined;
    if (starting && cmd?.[1] === "exec-control") return cmd[4] as Stage;
    return undefined;
  };
  Object.assign(api, {
    request: (input: EngineHttpRequest) =>
      Effect.gen(function* () {
        requests.push(input);
        const cmd = (input.body as { Cmd?: readonly string[] } | undefined)?.Cmd;
        const stage = stageFor(cmd, false);
        if (stage !== undefined) {
          events.push(stage);
          yield* hooks.before?.(stage, input) ?? Effect.void;
        }
        const response = yield* request(input);
        if (cmd !== undefined && response.status < 300)
          commands.set((JSON.parse(response.body) as { Id: string }).Id, cmd);
        return response;
      }),
    stream: (input: EngineHttpRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          requests.push(input);
          const id = /^\/exec\/([^/]+)\/start$/u.exec(input.path)?.[1];
          const stage = stageFor(id === undefined ? undefined : commands.get(id), true);
          if (stage !== undefined) {
            events.push(stage);
            yield* hooks.before?.(stage, input) ?? Effect.void;
            const replacement = hooks.replaceStream?.(stage, input);
            if (replacement !== undefined) return replacement;
            if (stage === "primary-start") primaryStarts++;
            if (stage === "launch") launches++;
          }
          return stream(input);
        }),
      ),
  });
  const run = (controller?: AbortController, extra: Partial<CommandSpec> = {}) => {
    const chunks: ExecChunk[] = [];
    const effect = execStream(
      plan,
      target,
      {
        command: ["test-command"],
        raw: true,
        tty: false,
        ...(controller === undefined ? {} : { signal: controller.signal }),
        ...extra,
      },
      { api, ctx, ...supervisedExecFixtureOptions(api) },
    ).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
        }),
      ),
      Effect.scoped,
      Effect.exit,
    );
    return Effect.runPromise(effect).then((exit) => ({ exit, chunks }));
  };
  return { api, requests, events, run, counts: () => ({ primaryStarts, launches }) };
};
const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
const terminalChunks = (chunks: readonly ExecChunk[]) => chunks.filter((chunk) => "exitCode" in chunk);

describe("non-TTY exec supervision lifecycle", () => {
  test.each([0, 7, 143])(
    "preserves immediate command exit %s only after joining and cleanup",
    async (exitCode) => {
      const f = fixture({ exitCode });
      const { exit, chunks } = await f.run();
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(terminalChunks(chunks)).toEqual([{ exitCode }]);
      expect(f.events).toContain("collect");
      expect(f.events).toContain("cleanup");
      expect(f.counts()).toEqual({ primaryStarts: 1, launches: 1 });
      const actions = f.requests.filter(
        (request) => request.path.startsWith("/containers/") && !request.path.endsWith("/json"),
      );
      expect(actions.every((request) => request.path.startsWith("/containers/immutable-container-id/"))).toBe(
        true,
      );
      const creates = actions.filter((request) => request.path.endsWith("/exec"));
      expect(creates.every((request) => (request.body as { User?: string }).User === target.user)).toBe(true);
    },
  );

  test("pre-aborted commands issue no provider actions or terminal status", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort("SIGINT");
    const { exit, chunks } = await f.run(controller);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(f.requests).toHaveLength(0);
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts()).toEqual({ primaryStarts: 0, launches: 0 });
  });

  test.each(["init-create", "init-start", "primary-create", "primary-start", "ready", "launch"] as const)(
    "cancellation during %s cannot release the child or report terminal success",
    async (stopAt) => {
      const controller = new AbortController();
      let intercepted = false;
      const f = fixture({
        before: (stage) =>
          stage === stopAt && !intercepted
            ? Effect.sync(() => {
                intercepted = true;
                controller.abort("SIGINT");
              }).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const { exit, chunks } = await f.run(controller);
      expect(intercepted).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminalChunks(chunks)).toHaveLength(0);
      expect(f.counts().launches).toBe(0);
      expect(f.events).toContain("cancel");
      expect(f.events).toContain("collect");
      const cancel = f.requests.find((request) => {
        const cmd = (request.body as { Cmd?: readonly string[] } | undefined)?.Cmd;
        return cmd?.[1] === "exec-control" && cmd[4] === "cancel";
      });
      expect((cancel?.body as { Cmd?: readonly string[] } | undefined)?.Cmd?.[5]).toBe("SIGINT");
      if (stopAt === "primary-create" || stopAt === "primary-start")
        expect(failureText(exit)).toContain("cleanup-unconfirmed");
    },
    25_000,
  );

  test("preserves a genuine primary attach failure through successful cleanup", async () => {
    const error = providerFailure("distinct-primary-transport-failure");
    const f = fixture({ mainError: error });
    const { exit, chunks } = await f.run();
    expect(failureText(exit)).toContain(error.message);
    expect(failureText(exit)).not.toContain("cleanup-unconfirmed");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).toContain("cancel");
    expect(f.events).toContain("cleanup");
  });

  test("a missing completion receipt cannot produce terminal success", async () => {
    let missing = false;
    const f = fixture({
      replaceStream: (stage) => {
        if (stage !== "status" || missing) return undefined;
        missing = true;
        return Stream.empty;
      },
    });
    const { exit, chunks } = await f.run();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("supervisor-observation");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).toContain("cancel");
  });

  test("a provider error before START preserves failure and blocks the child", async () => {
    const error = providerFailure("distinct-init-control-failure");
    const f = fixture({ before: (stage) => (stage === "init-create" ? Effect.fail(error) : Effect.void) });
    const { exit, chunks } = await f.run();
    expect(failureText(exit)).toContain(error.message);
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts()).toEqual({ primaryStarts: 0, launches: 0 });
    expect(f.events).toContain("cancel");
    expect(f.events).toContain("cleanup");
  });

  test("an unconfirmed cleanup remains an explicit failure beside the primary failure", async () => {
    const f = fixture({
      mainError: providerFailure("primary-error-before-uncertain-cleanup"),
      before: (stage) => {
        return stage === "cancel" || stage === "status"
          ? Effect.fail(providerFailure("cleanup-channel-down"))
          : Effect.void;
      },
    });
    const { exit, chunks } = await f.run();
    const text = failureText(exit);
    expect(text).toContain("primary-error-before-uncertain-cleanup");
    expect(text).toContain("cleanup-unconfirmed");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).not.toContain("cleanup");
  }, 25_000);

  test("missing helper capabilities fail closed before issuing a process", async () => {
    const f = fixture();
    const exit = await Effect.runPromiseExit(
      execStream(plan, target, { command: ["test-command"], raw: true }, { api: f.api, ctx }).pipe(
        Stream.runDrain,
        Effect.scoped,
      ),
    );
    expect(failureText(exit)).toContain("helper-unavailable");
    expect(f.requests).toHaveLength(0);
  });

  test("unsupported helper resolution retains its actionable error and never starts a process", async () => {
    const f = fixture();
    const exit = await Effect.runPromiseExit(
      execStream(
        plan,
        target,
        { command: ["test-command"], raw: true },
        {
          api: f.api,
          ctx,
          helperTarget: { os: "linux", arch: "x64" },
          resolveContainerHelper: (helperTarget) =>
            Effect.fail(
              new ContainerHelperUnavailableError({
                target: helperTarget,
                message: "Helper architecture unsupported.",
                remediation: "Select a supported architecture.",
              }),
            ),
        },
      ).pipe(Stream.runDrain, Effect.scoped),
    );
    expect(failureText(exit)).toContain("Helper architecture unsupported.");
    if (Exit.isSuccess(exit)) throw new Error("Unsupported helper unexpectedly executed.");
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause)).remediation).toBe(
      "Select a supported architecture.",
    );
    expect(f.events).toHaveLength(0);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});
