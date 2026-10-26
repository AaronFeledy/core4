import { dirname } from "node:path";
import { Effect, Result } from "effect";

import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
import { emitConfigYaml, writeValidationErrorFromIssues } from "@lando/engine/config-write/write-core";
import { hostProviderId } from "@lando/engine/providers/host-provider";
import { landofileLayerPaths } from "@lando/landofile/layers";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { parseLandofile } from "@lando/landofile/parser";
import { type LandofileContentLayer, loadLandofileContentLayers } from "@lando/landofile/root-compile";
import { ConfigError } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";

export const readGlobalText = (filePath: string): Effect.Effect<string, ConfigError> =>
  Effect.tryPromise({
    try: async () => ((await Bun.file(filePath).exists()) ? Bun.file(filePath).text() : ""),
    catch: (cause) =>
      new ConfigError({
        message: `Failed to read ${filePath}`,
        path: filePath,
        cause,
        remediation: `Fix permissions on ${filePath} or recreate it with \`lando config set\`.`,
      }),
  });

export const writeGlobalText = (filePath: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(filePath, content),
    catch: (cause) =>
      new ConfigError({
        message: `Failed to write ${filePath}`,
        path: filePath,
        cause,
        remediation: `Make ${filePath} writable, then retry the config write.`,
      }),
  });

export const parseGlobalTree = Effect.fnUntraced(function* (filePath: string, content: string) {
  if (content.trim() === "") return { name: "global", runtime: 4 } as Record<string, unknown>;
  return (yield* parseLandofile({ file: filePath, content, cwd: filePath })) as Record<string, unknown>;
});

export const compileGlobalConfigDocument = Effect.fnUntraced(function* (filePath: string, edited?: string) {
  const root = dirname(filePath);
  const layers: LandofileContentLayer[] = [];
  for (const position of landofileLayerPaths(root)) {
    const file = position.layer === "canonical" ? filePath : position.yamlPath;
    const content =
      position.layer === "canonical" && edited !== undefined ? edited : yield* readGlobalText(file);
    if (content.trim() !== "") layers.push({ ...position, filePath: file, content });
  }
  return yield* loadLandofileContentLayers(
    layers,
    {
      appRoot: root,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    },
    {
      file: filePath,
      forced: {
        name: "global",
        provider: yield* hostProviderId,
      },
    },
  ).pipe(
    Effect.mapError((error) =>
      writeValidationErrorFromIssues({
        file: filePath,
        issues:
          error._tag === "LandofileValidationError" ? error.issues : [validationIssue([], error.message)],
      }),
    ),
  );
});

export const decodeGlobalConfigDocument = (filePath: string) => (next: unknown) =>
  Effect.fromResult(emitConfigYaml({ file: filePath, value: next })).pipe(
    Effect.flatMap((content) => compileGlobalConfigDocument(filePath, content)),
    Effect.map(Result.succeed),
    Effect.catchTag("LandofileWriteValidationError", (error) => Effect.succeed(Result.fail(error.issues))),
  );
