import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type FileSyncDisposalPhase,
  type FileSyncSessionSpec,
  PortablePath,
  ServiceName,
  planFileSyncDisposal,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";
import { type MutagenProcessClient, makeMutagenProcessClient } from "../../src/mutagen-process-client.ts";

export const id = "sync_Abc123";
export const name = "cms-web-app-root";
export const source = "C:\\Users\\me\\CMS Project";
export const helper = "lando-sync-helper-123";
export const privateFileAccess = {
  enforce: async (_path: string) => undefined,
  verify: async (_path: string) => undefined,
};

export const spec: FileSyncSessionSpec = {
  app: { kind: "user", id: AppId.make("cms"), root: AbsolutePath.make(source) },
  service: ServiceName.make("web"),
  mountKey: "app-root",
  source: AbsolutePath.make(source),
  target: { _tag: "volume", name: "lando-sync-cms", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [".git", "vendor"],
};

export const session = (overrides: Record<string, unknown> = {}) => ({
  identifier: id,
  name,
  alpha: { protocol: "local", path: source, connected: true },
  beta: {
    protocol: "docker",
    host: helper,
    path: "/lando-data",
    environment: { DOCKER_HOST: "npipe:////./pipe/podman-lando", DOCKER_CONTEXT: "" },
    connected: true,
  },
  mode: "two-way-safe",
  ignore: { paths: [".git", "vendor"] },
  paused: false,
  status: "watching",
  successfulCycles: 1,
  ...overrides,
});

export const fake = (
  options: {
    mismatch?: boolean;
    unhealthy?: boolean;
    conflicts?: ReadonlyArray<unknown>;
    alphaTransitionProblems?: ReadonlyArray<unknown>;
    betaTransitionProblems?: ReadonlyArray<unknown>;
    excludedAlphaTransitionProblems?: number;
    preexisting?: boolean;
    failTerminate?: boolean;
    ambiguousId?: boolean;
    failCreateOnce?: boolean;
    failPauseOnce?: boolean;
    failTerminateOnce?: boolean;
    failTerminateAfterDeleteOnce?: boolean;
    transientScanningLists?: number;
    flushGate?: {
      readonly identifier: string;
      readonly entered: () => void;
      readonly release: Promise<void>;
    };
    betaEnvironment?: Readonly<Record<string, string>>;
    stateStore?: PluginStateStore;
  } = {},
) => {
  const calls: Array<{ args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = [];
  let sessions: Array<Record<string, unknown>> = options.preexisting ? [session()] : [];
  let failCreateOnce = options.failCreateOnce === true;
  let failPauseOnce = options.failPauseOnce === true;
  let failTerminateOnce = options.failTerminateOnce === true;
  let failTerminateAfterDeleteOnce = options.failTerminateAfterDeleteOnce === true;
  let targetResolutions = 0;
  let scanningRemaining = 0;
  const stateStore =
    options.stateStore ??
    makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/mutagen-process-client-test"),
      privateFileAccess,
    );
  const makeClient = (store: PluginStateStore = stateStore) =>
    makeMutagenProcessClient({
      stateStore: store,
      binDir: "C:\\lando\\bin",
      dataDir: "C:\\lando\\data\\file-sync\\sessions",
      dockerCliPath: "C:\\lando\\runtime\\docker.exe",
      dockerHost: "npipe:////./pipe/podman-lando",
      platform: "win32",
      arch: "x64",
      verifyInstalled: async () => true,
      resolveTarget: (requested) =>
        Effect.sync(() => {
          targetResolutions += 1;
          return {
            containerId: requested.service === spec.service ? helper : `${helper}-api`,
            path: "/lando-data",
          };
        }),
      runner: {
        run: Effect.fnUntraced(function* ({ args, env }) {
          const gate = options.flushGate;
          if (args[1] === "flush" && gate !== undefined && args[2] === gate.identifier) {
            gate.entered();
            yield* Effect.promise(() => gate.release);
          }
          return yield* Effect.sync(() => {
            calls.push({ args, env: env ?? {} });
            if (args[0] === "version") return { exitCode: 0, stdout: "Mutagen version 0.18.1", stderr: "" };
            if (args[1] === "list") {
              const listed =
                scanningRemaining > 0
                  ? sessions.map((entry) => ({ ...entry, status: "scanning" }))
                  : sessions;
              if (scanningRemaining > 0) scanningRemaining -= 1;
              return { exitCode: 0, stdout: JSON.stringify(listed), stderr: "" };
            }
            if (args[1] === "create") {
              if (failCreateOnce) {
                failCreateOnce = false;
                return { exitCode: 1, stdout: "", stderr: "create failed before session creation" };
              }
              const createdName = args[args.indexOf("--name") + 1] ?? name;
              const createdId = createdName === name ? id : "sync_New456";
              const beta = options.mismatch
                ? { protocol: "docker", host: "other", path: "/lando-data", connected: true }
                : {
                    protocol: "docker",
                    host: createdName.startsWith("cms-api") ? `${helper}-api` : helper,
                    path: "/lando-data",
                    environment: options.betaEnvironment ?? {
                      DOCKER_HOST: "npipe:////./pipe/podman-lando",
                      DOCKER_CONTEXT: "",
                    },
                    connected: true,
                  };
              sessions = [
                ...sessions,
                session({
                  name: createdName,
                  identifier: createdId,
                  alpha: { protocol: "local", path: args[args.length - 2], connected: true },
                  beta,
                }),
              ];
              return {
                exitCode: 0,
                stdout: options.ambiguousId
                  ? "Created session, ID unavailable\n"
                  : `Created session ${createdId}\n`,
                stderr: "",
              };
            }
            if (args[1] === "flush" && options.unhealthy)
              sessions = sessions.map((entry) => ({
                ...entry,
                conflicts: options.conflicts ?? [{ root: "README.md" }],
              }));
            if (
              args[1] === "flush" &&
              (options.alphaTransitionProblems !== undefined || options.betaTransitionProblems !== undefined)
            )
              sessions = sessions.map((entry) => ({
                ...entry,
                alpha: {
                  ...(entry.alpha as Record<string, unknown>),
                  transitionProblems: options.alphaTransitionProblems ?? [],
                  excludedTransitionProblems: options.excludedAlphaTransitionProblems ?? 0,
                },
                beta: {
                  ...(entry.beta as Record<string, unknown>),
                  transitionProblems: options.betaTransitionProblems ?? [],
                },
              }));
            if (args[1] === "flush") scanningRemaining = options.transientScanningLists ?? 0;
            if (args[1] === "pause") {
              sessions = sessions.map((entry) => ({ ...entry, paused: true }));
              if (failPauseOnce) {
                failPauseOnce = false;
                return { exitCode: 1, stdout: "", stderr: "pause interrupted" };
              }
            }
            if (args[1] === "resume") sessions = sessions.map((entry) => ({ ...entry, paused: false }));
            if (args[1] === "terminate") {
              if (options.failTerminate || failTerminateOnce) {
                failTerminateOnce = false;
                return { exitCode: 1, stdout: "", stderr: "sensitive target details" };
              }
              sessions = sessions.filter((entry) => entry.identifier !== args[2]);
              if (failTerminateAfterDeleteOnce) {
                failTerminateAfterDeleteOnce = false;
                return { exitCode: 1, stdout: "", stderr: "connection closed" };
              }
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          });
        }),
      },
    });
  const client = makeClient();
  return {
    client,
    reopen: makeClient,
    stateStore,
    calls,
    targetResolutions: () => targetResolutions,
    current: () => sessions,
    setCurrent: (value: Array<Record<string, unknown>>) => {
      sessions = value;
    },
  };
};

/** Run the SDK planner's remaining retirement steps for `phase` against a process client. */
export const runDisposalPlan = (client: MutagenProcessClient, phase: FileSyncDisposalPhase) =>
  Effect.forEach(
    planFileSyncDisposal(phase),
    (step) => {
      switch (step) {
        case "drain":
          return client.drainApp(spec.app);
        case "dispose":
          return client.disposeApp(spec.app);
        case "completeDisposal":
          return client.completeAppDisposal(spec.app);
        default: {
          const exhaustive: never = step;
          return exhaustive;
        }
      }
    },
    { discard: true },
  );
