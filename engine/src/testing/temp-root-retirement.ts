import { rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { dockerPullDialect } from "@lando/container-runtime/dialect";
import { makeDockerApiClient } from "@lando/container-runtime/docker/api-client";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { normalizeImageRef } from "@lando/container-runtime/image-list";
import { inspectRequest } from "@lando/container-runtime/image-pull";
import { removeContainerArtifact } from "@lando/container-runtime/image-remove";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { ProviderId } from "@lando/sdk/schema";
import type { ProcessResult, ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import {
  BUILT_ARTIFACT_STORE_LABEL,
  artifactBuildStoreKey,
  artifactBuildStorePrefix,
} from "../services/build-artifact-name.ts";
import { retireCliResources } from "./temp-root-cli.ts";
import { type TempRootRetirementError, retirementError, retirementFailures } from "./temp-root-failure.ts";
import {
  engineRequest,
  listStoreImages,
  ownedAppRoots,
  retireSharedNetwork,
  verifyRootResourcesAbsent,
} from "./temp-root-resources.ts";

export const TEST_ROOT_ENV_KEYS = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

export interface RetirementFinding {
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
  readonly priorFailures?: readonly RetirementFinding[];
}

export interface RetirementDependencies {
  readonly runCli?: (input: ProcessSpawnOptions) => Promise<ProcessResult>;
  readonly imageApi?: EngineHttpApi;
}

const imageId = (id: string) => id.replace(/^sha256:/u, "");
const ImageInspection = Schema.fromJsonString(
  Schema.Struct({
    Id: Schema.String,
    RepoTags: Schema.NullOr(Schema.Array(Schema.String)),
    Config: Schema.Struct({ Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) }),
  }),
);

const retireImages = Effect.fnUntraced(function* (scope: Parameters<typeof listStoreImages>[0]) {
  const { api, context, store } = scope;
  const removed: string[] = [];
  const retained: RetirementFinding[] = [];
  const failed: TempRootRetirementError[] = [];
  const listed = yield* listStoreImages(scope).pipe(retirementFailures("built images"));
  const prefix = artifactBuildStorePrefix(store);
  for (const id of new Set(listed.map((row) => row.id))) {
    yield* Effect.gen(function* () {
      const response = yield* engineRequest(scope, inspectRequest(dockerPullDialect, id), true);
      if (response.status === 404) return;
      const image = yield* Schema.decodeUnknownEffect(ImageInspection)(response.body);
      if (imageId(image.Id) !== imageId(id) || image.Config.Labels?.[BUILT_ARTIFACT_STORE_LABEL] !== store) {
        retained.push({ target: id, reason: "Image identity or build-store label no longer matches." });
        return;
      }
      const tags = (image.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>");
      const foreign = tags.filter((tag) => !normalizeImageRef(tag).startsWith(prefix));
      if (foreign.length > 0) {
        retained.push({ target: id, reason: `Foreign tags: ${foreign.join(", ")}` });
        return;
      }
      // Engines refuse to delete an image by ID while several names tag it, so remove each owned
      // name; the last one removes the image.
      let removedAny = false;
      for (const ref of tags.length === 0 ? [id] : tags) {
        const result = yield* removeContainerArtifact(
          api,
          { providerId: ProviderId.make(context.providerId), ref },
          context,
        );
        switch (result.kind) {
          case "removed":
            removedAny = true;
            break;
          case "absent":
            break;
          case "in-use":
            retained.push({ target: id, reason: [result.reason, ...result.containers].join("; ") });
            return;
          default: {
            const exhaustive: never = result;
            return yield* retirementError(id, exhaustive);
          }
        }
      }
      if (removedAny) removed.push(id);
    }).pipe(
      retirementFailures(id),
      Effect.catch((error) =>
        Effect.sync(() => {
          failed.push(error);
        }),
      ),
    );
  }
  return { removed, retained, failed };
});

const bindOwnedRoot = Effect.fnUntraced(function* (input: TempRootRetirement) {
  const env: TempRootRetirement["env"] = {
    ...input.env,
    BUN_BE_BUN: undefined,
    LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
  };
  const providerId = input.env.LANDO_PROVIDER ?? "podman";
  const dockerHost = input.env.DOCKER_HOST;
  const endpoint =
    providerId === "docker" ? dockerHost?.replace(/^unix:\/\//u, "") : input.env.LANDO_TEST_PODMAN_SOCKET;
  const fail = (message: string) => retirementError(input.directory, message);
  if (
    (providerId !== "podman" && providerId !== "docker") ||
    !endpoint ||
    endpoint !== input.endpoint ||
    (providerId === "podman" && dockerHost !== undefined && dockerHost !== `unix://${endpoint}`)
  ) {
    return yield* fail(
      "Retirement endpoint does not match the explicit provider endpoint in the owned environment.",
    );
  }
  const canonical = (path: string) => canonicalMissingAppRoot(path).pipe(retirementFailures(input.directory));
  const directory = yield* canonical(input.directory);
  const roots = new Map<string, string>();
  for (const key of TEST_ROOT_ENV_KEYS) {
    const value = input.env[key];
    if (!value || !isAbsolute(value))
      return yield* fail(`${key} must be inside the owned temporary directory.`);
    const path = yield* canonical(value);
    const child = relative(directory, path);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      return yield* fail(`${key} must be inside the owned temporary directory.`);
    }
    roots.set(key, path);
  }
  const dataRoot = roots.get("LANDO_USER_DATA_ROOT");
  const cacheRoot = roots.get("LANDO_USER_CACHE_ROOT");
  if (dataRoot === undefined || cacheRoot === undefined)
    return yield* fail("Retirement requires data and cache roots.");
  const store = yield* artifactBuildStoreKey(cacheRoot).pipe(retirementFailures(input.directory));
  return { env, endpoint, providerId, dataRoot, store };
});

export const retireTempRootsEffect = Effect.fnUntraced(function* (
  input: TempRootRetirement,
  dependencies: RetirementDependencies = {},
) {
  const prior = (input.priorFailures ?? []).map(({ target, reason }) => retirementError(target, reason));
  const binding = yield* Effect.result(bindOwnedRoot(input));
  if (binding._tag === "Failure")
    return { removed: [], retained: [], failed: [...prior, binding.failure] } satisfies RetirementOutcome;
  const { env, endpoint, providerId, dataRoot, store } = binding.success;
  const context = { providerId, env, remediation: "Check the live test provider endpoint." };
  const api =
    dependencies.imageApi ??
    (providerId === "docker"
      ? makeDockerApiClient(endpoint, context)
      : makePodmanApiClient(endpoint, context));
  const scope = { api, context, dataRoot, store };
  const cliEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const cliFailures = yield* retireCliResources({
    command: input.command,
    directory: input.directory,
    env: cliEnv,
    providerId,
    ownedAppRoots: ownedAppRoots(scope).pipe(
      Effect.timeout("30 seconds"),
      retirementFailures("app ownership verification"),
    ),
    ...(dependencies.runCli === undefined ? {} : { runCli: dependencies.runCli }),
  });
  const images = yield* retireImages(scope).pipe(
    Effect.timeout("30 seconds"),
    retirementFailures("built images"),
    Effect.catch((error) => Effect.succeed({ removed: [], retained: [], failed: [error] })),
  );
  const network = yield* retireSharedNetwork(scope);
  const verified = yield* verifyRootResourcesAbsent(scope);
  const retained = [...images.retained, ...network.retained];
  retained.push(
    ...verified.retained.filter(({ target }) => !retained.some((finding) => finding.target === target)),
  );
  const failed = [...prior, ...cliFailures, ...images.failed, ...network.failed, ...verified.failed];
  if (retained.length === 0 && failed.length === 0) {
    yield* Effect.tryPromise({
      try: () => rm(input.directory, { recursive: true, force: true }),
      catch: (cause) => retirementError(input.directory, cause),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failed.push(error);
        }),
      ),
    );
  }
  return { removed: [...images.removed, ...network.removed], retained, failed } satisfies RetirementOutcome;
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
