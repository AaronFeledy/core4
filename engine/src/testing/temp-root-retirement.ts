import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { makeDockerApiClient } from "@lando/container-runtime/docker/api-client";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import type { ProcessResult, ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Schema, Stream } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { artifactBuildStoreKey } from "../services/build-artifact-name.ts";
import { service as processRunner } from "../services/process-runner.ts";
import { type TempRootRetirementError, retirementError, retirementFailures } from "./temp-root-failure.ts";
import { rootResourceLists, verifyRootResourcesAbsent } from "./temp-root-resources.ts";

export const TEST_ROOT_ENV_KEYS = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

export const TEMP_PODMAN_ROOT_SETUP_ARGS = [
  "setup",
  "--provider=podman",
  "--skip-proxy",
  "--skip-shell-integration",
  "--skip-file-sync",
  "--skip-install-ca",
  "--yes",
  "--no-interactive",
] as const;

export const tempPodmanRootEnv = (directory: string, endpoint: string) => ({
  LANDO_USER_DATA_ROOT: join(directory, "lando_user_data_root"),
  LANDO_USER_CONF_ROOT: join(directory, "lando_user_conf_root"),
  LANDO_USER_CACHE_ROOT: join(directory, "lando_user_cache_root"),
  LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "lando_system_plugin_root"),
  LANDO_SHELL_PROFILE: join(directory, "shell-profile"),
  LANDO_PROVIDER: "podman",
  LANDO_CONFIG__default_provider_id: "podman",
  LANDO_TEST_PODMAN_SOCKET: endpoint,
  DOCKER_HOST: `unix://${endpoint}`,
  LANDO_TEST_DOCKER_SOCKET: undefined,
  LANDO_TEST_WINDOWS_DOCKER_SOCKET: undefined,
  BUN_BE_BUN: undefined,
  LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
});

interface RetirementFinding {
  readonly target: string;
  readonly reason: string;
}

interface RetirementOutcome {
  readonly removed: readonly string[];
  readonly retained: readonly RetirementFinding[];
  readonly failed: readonly TempRootRetirementError[];
}

export interface RetirementResult {
  readonly removed: readonly string[];
  readonly retained: readonly RetirementFinding[];
  readonly failed: readonly (RetirementFinding & { readonly _tag: string; readonly remediation: string })[];
}

export interface TempRootRetirement {
  readonly directory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly endpoint: string;
  readonly command: readonly [string, ...string[]];
}

interface RetirementDependencies {
  readonly runCli?: (input: ProcessSpawnOptions) => Promise<ProcessResult>;
  readonly engineApi?: EngineHttpApi;
}

const Envelope = Schema.fromJsonString(
  Schema.Union([CommandResultEnvelope, Schema.TaggedStruct("result", { envelope: CommandResultEnvelope })]),
);
const PURGE = "uninstall --purge";

const bindOwnedRoot = Effect.fnUntraced(function* (input: TempRootRetirement) {
  const { endpoint } = input;
  const providerId = input.env.LANDO_PROVIDER ?? "podman";
  const dockerHost = `unix://${endpoint}`;
  const fail = (message: string) => retirementError(input.directory, message);
  const endpointBindings = {
    LANDO_TEST_PODMAN_SOCKET: endpoint,
    LANDO_TEST_DOCKER_SOCKET: dockerHost,
    LANDO_TEST_WINDOWS_DOCKER_SOCKET: dockerHost,
    DOCKER_HOST: dockerHost,
  };
  if (
    !isAbsolute(endpoint) ||
    (providerId !== "podman" && providerId !== "docker") ||
    (providerId === "podman"
      ? input.env.LANDO_TEST_PODMAN_SOCKET !== endpoint
      : input.env.DOCKER_HOST !== dockerHost) ||
    Object.entries(endpointBindings).some(
      ([key, value]) => input.env[key] !== undefined && input.env[key] !== value,
    )
  ) {
    return yield* fail(
      "Retirement endpoint does not match the explicit provider endpoint in the owned environment.",
    );
  }

  const canonical = (path: string) => canonicalMissingAppRoot(path).pipe(retirementFailures(input.directory));
  const directory = yield* canonical(input.directory);
  const ownedPath = Effect.fnUntraced(function* (key: string, value: string | undefined) {
    if (value === undefined || !isAbsolute(value))
      return yield* fail(`${key} must be inside the owned temporary directory.`);
    const path = yield* canonical(value);
    const child = relative(directory, path);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      return yield* fail(`${key} must be inside the owned temporary directory.`);
    }
    return path;
  });
  const [dataRoot, confRoot, cacheRoot, systemPluginRoot] = yield* Effect.all([
    ownedPath("LANDO_USER_DATA_ROOT", input.env.LANDO_USER_DATA_ROOT),
    ownedPath("LANDO_USER_CONF_ROOT", input.env.LANDO_USER_CONF_ROOT),
    ownedPath("LANDO_USER_CACHE_ROOT", input.env.LANDO_USER_CACHE_ROOT),
    ownedPath("LANDO_SYSTEM_PLUGIN_ROOT", input.env.LANDO_SYSTEM_PLUGIN_ROOT),
  ]);
  const shellProfile = yield* ownedPath("LANDO_SHELL_PROFILE", join(directory, "shell-profile"));
  const store = yield* artifactBuildStoreKey(cacheRoot).pipe(retirementFailures(input.directory));
  const env = Object.fromEntries(
    Object.entries({
      ...input.env,
      ...endpointBindings,
      LANDO_USER_DATA_ROOT: dataRoot,
      LANDO_USER_CONF_ROOT: confRoot,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_SYSTEM_PLUGIN_ROOT: systemPluginRoot,
      LANDO_SHELL_PROFILE: shellProfile,
      BUN_BE_BUN: undefined,
      LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { directory, env, endpoint, providerId, dataRoot, store } as const;
});

const resourceScope = (
  binding: Effect.Success<ReturnType<typeof bindOwnedRoot>>,
  engineApi?: EngineHttpApi,
) => {
  const { providerId, env, endpoint, dataRoot, store } = binding;
  const context = { providerId, env, remediation: "Check the live test provider endpoint." };
  const api =
    engineApi ??
    (providerId === "docker"
      ? makeDockerApiClient(endpoint, context)
      : makePodmanApiClient(endpoint, context));
  return { api, context, dataRoot, store };
};

export const bindTempRootObservation = Effect.fnUntraced(function* (input: TempRootRetirement) {
  const scope = resourceScope(yield* bindOwnedRoot(input));
  return Effect.all(rootResourceLists(scope), { concurrency: "unbounded" }).pipe(
    Effect.timeout("30 seconds"),
  );
});

const runProcess = Effect.fnUntraced(function* (input: ProcessSpawnOptions) {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const result = yield* processRunner.streamWithExit(input).pipe(
    Stream.runFold(
      () => ({ exitCode: 1, stdout: "", stderr: "" }),
      (result, event) =>
        "exitCode" in event
          ? { ...result, exitCode: event.exitCode }
          : {
              ...result,
              [event.kind]: result[event.kind] + decoders[event.kind].decode(event.chunk, { stream: true }),
            },
    ),
  );
  return {
    ...result,
    stdout: result.stdout + decoders.stdout.decode(),
    stderr: result.stderr + decoders.stderr.decode(),
  };
});

export const retireTempRootsEffect = Effect.fnUntraced(function* (
  input: TempRootRetirement,
  dependencies: RetirementDependencies = {},
) {
  const binding = yield* Effect.result(bindOwnedRoot(input));
  if (binding._tag === "Failure")
    return { removed: [], retained: [], failed: [binding.failure] } satisfies RetirementOutcome;
  const { directory, env } = binding.success;
  const [cmd, ...prefix] = input.command;
  const options = {
    cmd,
    args: [...prefix, "uninstall", "--purge", "--yes", "--format=json"],
    cwd: directory,
    env,
    replaceEnv: true,
    capture: true,
    timeoutMs: 120_000,
  } satisfies ProcessSpawnOptions;
  const runner = dependencies.runCli;
  const purge = yield* Effect.result(
    runner === undefined
      ? runProcess(options).pipe(retirementFailures(PURGE))
      : Effect.tryPromise({ try: () => runner(options), catch: (cause) => retirementError(PURGE, cause) }),
  );
  if (purge._tag === "Failure")
    return { removed: [], retained: [], failed: [purge.failure] } satisfies RetirementOutcome;
  const { exitCode, stdout, stderr } = purge.success;
  const decoded = Schema.decodeUnknownOption(Envelope)(stdout.trim().split("\n").at(-1));
  const envelope =
    decoded._tag === "Some"
      ? "envelope" in decoded.value
        ? decoded.value.envelope
        : decoded.value
      : undefined;
  if (exitCode !== 0 || envelope?.ok !== true) {
    const detail =
      exitCode === 0 && envelope === undefined
        ? "Expected a successful uninstall JSON result."
        : `Exit ${exitCode}.`;
    const output = (stdout.trim() || stderr.trim()).slice(-4096);
    return {
      removed: [],
      retained: [],
      failed: [retirementError(PURGE, `${detail} ${output}`)],
    } satisfies RetirementOutcome;
  }

  // Purge can remove the Lando roots. Verify with the identity bound before it ran.
  const verified = yield* verifyRootResourcesAbsent(resourceScope(binding.success, dependencies.engineApi));
  if (verified.retained.length > 0 || verified.failed.length > 0)
    return { removed: [], ...verified } satisfies RetirementOutcome;
  const removal = yield* Effect.result(
    Effect.tryPromise({
      try: () => rm(input.directory, { recursive: true, force: true }),
      catch: (cause) => retirementError(input.directory, cause),
    }),
  );
  return removal._tag === "Failure"
    ? ({ removed: [], retained: [], failed: [removal.failure] } satisfies RetirementOutcome)
    : ({ removed: [input.directory], retained: [], failed: [] } satisfies RetirementOutcome);
});

export const retirementReport = (outcome: RetirementOutcome): RetirementResult => ({
  ...outcome,
  failed: outcome.failed.map(({ target, message, _tag, remediation }) => ({
    target,
    reason: message,
    _tag,
    remediation,
  })),
});

export const retireTempRoots = (input: TempRootRetirement, dependencies?: RetirementDependencies) =>
  Effect.runPromise(retireTempRootsEffect(input, dependencies)).then(retirementReport);
