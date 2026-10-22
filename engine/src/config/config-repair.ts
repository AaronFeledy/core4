import { dirname } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { type ConfigLayer, configRecord, readGlobalConfigSources } from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { GlobalConfigSources } from "../services/config.ts";
import { configCommandIds } from "./config-command-ids.ts";
import { recordConfigWarning } from "./config-warnings.ts";
import { decodeGlobalConfigFile, decodeGlobalConfigSources } from "./global-config.ts";

export const decodeConfigStack = Effect.fnUntraced(function* (
  stack: readonly ConfigLayer[],
  excessKeys: "warn" | "error",
) {
  const inputs = yield* GlobalConfigSources;
  const commandIds = yield* configCommandIds(stack, inputs);
  return decodeGlobalConfigSources(stack, {
    excessKeys,
    ...(commandIds === undefined ? {} : { commandIds }),
  });
});

export const configSourceStack = Effect.fnUntraced(function* (file?: string) {
  const inputs = yield* GlobalConfigSources;
  return yield* Effect.try({
    try: () => {
      const path = makeLandoPaths({
        ...inputs.rootOverrides,
        env: inputs.env,
        host: inputs.host,
        sources: inputs.sources,
      }).configFile;
      return readGlobalConfigSources(
        file === undefined || file === path
          ? inputs
          : { ...inputs, rootOverrides: { ...inputs.rootOverrides, userConfRoot: dirname(file) } },
      );
    },
    catch: (cause) => new ConfigError({ message: "Failed to acquire global configuration sources.", cause }),
  });
});

export const validateConfigCandidate = Effect.fnUntraced(function* (
  input: unknown,
  file: string,
  options: { readonly reportOtherSources?: boolean } = {},
) {
  if (!configRecord(input)) return decodeGlobalConfigFile(input, file);
  const stack = yield* configSourceStack(file);
  const inputs = yield* GlobalConfigSources;
  const commandIds = yield* configCommandIds(stack, inputs);
  const candidate = decodeGlobalConfigFile(input, file, {
    ...(commandIds === undefined ? {} : { commandIds }),
  });
  if (Result.isFailure(candidate) || options.reportOtherSources === false) return candidate;
  const replacement: ConfigLayer = { layer: "config-file", file, tree: input };
  const full = decodeGlobalConfigSources(
    stack.some((layer) => layer.layer === "config-file")
      ? stack.map((layer) => (layer.layer === "config-file" ? replacement : layer))
      : [stack[0] ?? { layer: "default", tree: {} }, replacement, ...stack.slice(1)],
    { excessKeys: "error", ...(commandIds === undefined ? {} : { commandIds }) },
  );
  if (Result.isFailure(full)) {
    yield* recordConfigWarning({
      code: "LANDO_CONFIG_OTHER_SOURCE_INVALID",
      message: full.failure.message,
      remediation: full.failure.remediation ?? "Fix the reported configuration source.",
    });
  } else {
    for (const message of full.success.warnings)
      yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
  }
  return candidate;
});
