import { dirname } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { type ConfigLayer, configRecord, readGlobalConfigSources } from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { recordCommandWarning } from "../landofile/command-warnings.ts";
import { GlobalConfigSources } from "../services/config.ts";
import { decodeGlobalConfigFile, decodeGlobalConfigSources } from "./global-config.ts";

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

export const validateConfigCandidate = Effect.fnUntraced(function* (input: unknown, file: string) {
  if (!configRecord(input)) return decodeGlobalConfigFile(input, file);
  const candidate = decodeGlobalConfigFile(input, file);
  if (Result.isFailure(candidate)) return candidate;
  const stack = yield* configSourceStack(file);
  const replacement: ConfigLayer = { layer: "config-file", file, tree: input };
  const full = decodeGlobalConfigSources(
    stack.some((layer) => layer.layer === "config-file")
      ? stack.map((layer) => (layer.layer === "config-file" ? replacement : layer))
      : [stack[0] ?? { layer: "default", tree: {} }, replacement, ...stack.slice(1)],
    { excessKeys: "error" },
  );
  if (Result.isFailure(full)) {
    yield* recordCommandWarning({
      code: "LANDO_CONFIG_OTHER_SOURCE_INVALID",
      message: full.failure.message,
      remediation: full.failure.remediation ?? "Fix the reported configuration source.",
    });
  } else {
    for (const message of full.success.warnings)
      yield* recordCommandWarning({ code: "LANDO_CONFIG_WARNING", message });
  }
  return candidate;
});
