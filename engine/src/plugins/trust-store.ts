import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { Effect, Layer, Option } from "effect";

import { ConfigError, type StateStoreError } from "@lando/sdk/errors";
import { PathsService, type PluginTrustState, PluginTrustStore } from "@lando/sdk/services";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { writeFileAtomicViaRename } from "../cache/atomic.ts";

const emptyState: PluginTrustState = { trustedPlugins: [], trustedAuthoringRoots: [] };

const configError = (path: string, message: string, cause?: unknown): ConfigError => {
  const remediation = message.includes("Malformed")
    ? "Fix the YAML list entries under trustedPlugins/trustedAuthoringRoots, then retry."
    : message.includes("read")
      ? `Fix permissions on ${path} so Lando can read the plugin trust store.`
      : `Fix permissions on ${path} so Lando can write the plugin trust store.`;
  return new ConfigError({
    message,
    path,
    remediation,
    ...(cause === undefined ? {} : { cause }),
  });
};

const quoted = (value: string): string => JSON.stringify(value);

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)].sort();

const emitTrustYaml = (state: PluginTrustState): string =>
  [
    "trustedPlugins:",
    ...uniqueSorted(state.trustedPlugins).map((plugin) => `  - ${quoted(plugin)}`),
    "trustedAuthoringRoots:",
    ...uniqueSorted(state.trustedAuthoringRoots).map((root) => `  - ${quoted(root)}`),
    "",
  ].join("\n");

const parseScalar = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseTrustYaml = (path: string, text: string): PluginTrustState => {
  const state = { trustedPlugins: [] as string[], trustedAuthoringRoots: [] as string[] };
  let section: keyof PluginTrustState | undefined;
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "trustedPlugins:") {
      section = "trustedPlugins";
      continue;
    }
    if (trimmed === "trustedAuthoringRoots:") {
      section = "trustedAuthoringRoots";
      continue;
    }
    if (trimmed.startsWith("- ") && section !== undefined) {
      state[section].push(parseScalar(trimmed.slice(2)));
      continue;
    }
    throw configError(path, `Malformed plugin trust YAML at line ${index + 1}`);
  }
  return state;
};

const containsPath = (root: string, candidate: string): boolean => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const makePluginTrustStore = (path: string): typeof PluginTrustStore.Service => {
  const readState = Effect.tryPromise({
    try: async () => {
      if (!existsSync(path)) return emptyState;
      return parseTrustYaml(path, await readFile(path, "utf8"));
    },
    catch: (cause) =>
      cause instanceof ConfigError ? cause : configError(path, "Failed to read plugin trust store.", cause),
  });

  const writeState = (state: PluginTrustState) =>
    Effect.tryPromise({
      try: () => writeFileAtomicViaRename(path, emitTrustYaml(state)),
      catch: (cause) => configError(path, "Failed to write plugin trust store.", cause),
    });

  // Concurrent plugin commands each read, change, and rewrite the whole file, so
  // one lock spans the read and the write or the second writer drops the first change.
  const changeState = (change: (state: PluginTrustState) => PluginTrustState) => {
    const locked = (access: typeof PrivateFileAccessService.Service) =>
      withAdvisoryLockUsing(access, { expireLiveOwner: false })(
        path,
        "plugin-trust",
        readState.pipe(Effect.flatMap((state) => writeState(change(state)))),
      ).pipe(
        mapFailures((cause: ConfigError | StateStoreError) =>
          cause instanceof ConfigError
            ? cause
            : configError(path, "Failed to lock the plugin trust store for writing.", cause),
        ),
      );
    return Effect.serviceOption(PrivateFileAccessService).pipe(
      Effect.flatMap((access) =>
        Option.isSome(access)
          ? locked(access.value)
          : Effect.scoped(PrivateFileAccessService.pipe(Effect.flatMap(locked))).pipe(
              Effect.provide(PrivateFileAccessService.layer),
            ),
      ),
    );
  };

  return PluginTrustStore.of({
    read: readState,
    isPluginTrusted: (name) => readState.pipe(Effect.map((state) => state.trustedPlugins.includes(name))),
    trustPlugin: (name) =>
      changeState((state) => ({ ...state, trustedPlugins: uniqueSorted([...state.trustedPlugins, name]) })),
    untrustPlugin: (name) =>
      changeState((state) => ({
        ...state,
        trustedPlugins: state.trustedPlugins.filter((entry) => entry !== name),
      })),
    isAuthoringRootTrusted: (pathToCheck) =>
      readState.pipe(
        Effect.map((state) => state.trustedAuthoringRoots.some((root) => containsPath(root, pathToCheck))),
      ),
    trustAuthoringRoot: (root) =>
      changeState((state) => ({
        ...state,
        trustedAuthoringRoots: uniqueSorted([...state.trustedAuthoringRoots, resolve(root)]),
      })),
  });
};

export const layer = Layer.effect(
  PluginTrustStore,
  Effect.map(PathsService, (paths) => makePluginTrustStore(paths.pluginTrustFile)),
);
