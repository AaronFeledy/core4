import { join } from "node:path";
import { detectTemplateDirective } from "@lando/landofile/template-render";
import { ConfigError, NotImplementedError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { writeFileAtomicViaRename } from "../cache/atomic.ts";
import { findDiscoveredLandofilePath } from "../services/landofile-live.ts";

export const resolveAppConfigFile = Effect.fn("AppConfig.resolveFile")(function* (
  cwd: string,
  subcommand: string,
) {
  const discovered = yield* findDiscoveredLandofilePath(cwd);
  const typescript = join(discovered.appRoot, ".lando.ts");
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(typescript).exists(),
    catch: (cause) => new ConfigError({ message: "Failed to inspect the canonical Landofile.", cause }),
  });
  if (subcommand !== "validate" && exists)
    return yield* Effect.fail(
      new NotImplementedError({
        message: `\`lando app config ${subcommand}\` does not support the TypeScript Landofile at ${typescript}.`,
        commandId: "app:config",
        remediation:
          "Edit the TypeScript source directly, or inspect it with `lando app config view --source resolved`.",
      }),
    );
  return { appRoot: discovered.appRoot, inputPath: join(discovered.appRoot, ".lando.yml") };
});

export const readAppConfigFile = (file: string) =>
  Effect.tryPromise({
    try: async () => ((await Bun.file(file).exists()) ? Bun.file(file).text() : ""),
    catch: (cause) => new ConfigError({ message: `Failed to read ${file}`, path: file, cause }),
  });

export const readMutableAppConfigFile = (file: string, subcommand: string) =>
  readAppConfigFile(file).pipe(
    Effect.flatMap((content) => {
      const directive = detectTemplateDirective(content);
      return directive === undefined
        ? Effect.succeed(content)
        : Effect.fail(
            new NotImplementedError({
              message: `\`lando app config ${subcommand}\` does not support the templated Landofile at ${file} (\`template: ${directive.engineId}\`).`,
              commandId: "app:config",
              remediation:
                "Use `lando app config edit` to preserve the template directive and authored source.",
            }),
          );
    }),
  );

export const writeAppConfigFile = (file: string, content: string) =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(file, content),
    catch: (cause) => new ConfigError({ message: `Failed to write ${file}`, path: file, cause }),
  });
