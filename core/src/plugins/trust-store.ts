import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { type PluginTrustState, PluginTrustStore } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../cache/atomic.ts";
import { makeLandoPaths } from "../config/paths.ts";

const emptyState: PluginTrustState = { trustedPlugins: [], trustedAuthoringRoots: [] };

const configError = (path: string, message: string, cause?: unknown): ConfigError =>
  new ConfigError({ message, path, ...(cause === undefined ? {} : { cause }) });

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

  return {
    read: readState,
    isPluginTrusted: (name) => readState.pipe(Effect.map((state) => state.trustedPlugins.includes(name))),
    trustPlugin: (name) =>
      readState.pipe(
        Effect.flatMap((state) =>
          writeState({ ...state, trustedPlugins: uniqueSorted([...state.trustedPlugins, name]) }),
        ),
      ),
    untrustPlugin: (name) =>
      readState.pipe(
        Effect.flatMap((state) =>
          writeState({ ...state, trustedPlugins: state.trustedPlugins.filter((entry) => entry !== name) }),
        ),
      ),
    isAuthoringRootTrusted: (pathToCheck) =>
      readState.pipe(
        Effect.map((state) => state.trustedAuthoringRoots.some((root) => containsPath(root, pathToCheck))),
      ),
    trustAuthoringRoot: (root) =>
      readState.pipe(
        Effect.flatMap((state) =>
          writeState({
            ...state,
            trustedAuthoringRoots: uniqueSorted([...state.trustedAuthoringRoots, resolve(root)]),
          }),
        ),
      ),
  };
};

export const PluginTrustStoreLive = Layer.effect(
  PluginTrustStore,
  Effect.succeed(makePluginTrustStore(makeLandoPaths().pluginTrustFile)),
);
