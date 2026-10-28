import { dirname, join } from "node:path";
import { Effect, Predicate, Result } from "effect";

import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
import { assertConfigReadable } from "@lando/engine/config-write/readiness";
import { emitConfigYaml, writeValidationErrorFromIssues } from "@lando/engine/config-write/write-core";
import { globalLandofileOverrides } from "@lando/engine/operations/global-plan";
import { loadLandofileLayers, validateLandofileReplacement } from "@lando/engine/services/landofile-live";
import { parseLandofile } from "@lando/landofile/parser";
import { detectTemplateDirective } from "@lando/landofile/template-render";
import { ConfigError, NotImplementedError } from "@lando/sdk/errors";
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
  if (content.trim() === "") return {};
  const value = yield* parseLandofile({ file: filePath, content, cwd: dirname(filePath) });
  if (Predicate.isObject(value) && !Array.isArray(value)) return value;
  return yield* Effect.fail(
    writeValidationErrorFromIssues({
      file: filePath,
      issues: [validationIssue([], "Expected a Landofile mapping.")],
    }),
  );
});

export const compileGlobalConfigDocument = Effect.fnUntraced(function* (filePath: string, edited?: string) {
  const root = dirname(filePath);
  const overrides = yield* globalLandofileOverrides;
  if (edited !== undefined) {
    return yield* validateLandofileReplacement(
      { appRoot: root, targetFile: filePath, content: edited },
      overrides,
    );
  }
  yield* loadLandofileLayers(root, filePath, overrides).pipe(
    Effect.catchTag("LandofileValidationError", (error) =>
      Effect.fail(writeValidationErrorFromIssues({ file: error.file, issues: error.issues })),
    ),
  );
});

export const requireMutableGlobalLandofile = Effect.fnUntraced(function* (
  filePath: string,
  subcommand: string,
) {
  const typescript = join(dirname(filePath), ".lando.ts");
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(typescript).exists(),
    catch: (cause) =>
      new ConfigError({
        message: "Failed to inspect the canonical Landofile.",
        cause,
        remediation: "Ensure the global root Landofile exists and is readable, then retry.",
      }),
  });
  if (exists)
    return yield* Effect.fail(
      new NotImplementedError({
        message: `\`lando global:config ${subcommand}\` does not support the TypeScript Landofile at ${typescript}.`,
        commandId: "global:config",
        remediation: "Edit the TypeScript source directly, or inspect it with `lando global:config`.",
      }),
    );
});

export const decodeGlobalConfigDocument = (filePath: string) => (next: unknown) =>
  Effect.fromResult(emitConfigYaml({ file: filePath, value: next })).pipe(
    Effect.flatMap((content) => compileGlobalConfigDocument(filePath, content)),
    Effect.map(Result.succeed),
    Effect.catchTag("LandofileWriteValidationError", (error) => Effect.succeed(Result.fail(error.issues))),
  );

export const globalConfigDocument = (file: string, verb: "set" | "unset" | "edit") => ({
  file,
  readText: assertConfigReadable(dirname(file)).pipe(
    Effect.andThen(readGlobalText(file)),
    Effect.flatMap((content) =>
      verb !== "edit" && detectTemplateDirective(content) !== undefined
        ? Effect.fail(
            new NotImplementedError({
              message: `\`lando global:config ${verb}\` does not support the templated Landofile at ${file}.`,
              commandId: "global:config",
              remediation:
                "Use `lando global:config edit` to preserve the template directive and authored source.",
            }),
          )
        : Effect.succeed(content),
    ),
  ),
  parse: (text: string) => parseGlobalTree(file, text),
  editCommand: "lando global:config edit",
  decode: decodeGlobalConfigDocument(file),
  validateText: (content: string) =>
    compileGlobalConfigDocument(file, content).pipe(
      Effect.map(Result.succeed),
      Effect.catchTag("LandofileWriteValidationError", (error) => Effect.succeed(Result.fail(error.issues))),
    ),
  writeText: writeGlobalText,
});
