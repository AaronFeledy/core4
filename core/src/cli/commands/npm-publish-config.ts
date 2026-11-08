import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIoError } from "@lando/sdk/errors";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect, Layer } from "effect";

class NpmPublishConfigFiles extends Context.Service<
  NpmPublishConfigFiles,
  { readonly create: (contents: string) => Effect.Effect<string, FileIoError, import("effect").Scope.Scope> }
>()("@lando/core/NpmPublishConfigFiles") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const access = yield* PrivateFileAccessService;
      return NpmPublishConfigFiles.of({
        create: Effect.fn("NpmPublishConfigFiles.create")(function* (contents) {
          const directory = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => mkdtemp(join(tmpdir(), "lando-npm-publish-")),
              catch: () =>
                new FileIoError({
                  path: tmpdir(),
                  message: "Could not create private Bun configuration.",
                  remediation: "Check temporary directory permissions and retry.",
                }),
            }),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const path = join(directory, "bunfig.toml");
          yield* Effect.tryPromise({
            try: async () => {
              await access.enforce(directory);
              await writeFile(path, contents, { mode: 0o600, flag: "wx" });
              await access.enforce(path);
              await access.verify(path);
            },
            catch: () =>
              new FileIoError({
                path,
                message: "Could not write owner-only Bun configuration.",
                remediation: "Check temporary directory permissions and retry.",
              }),
          });
          return path;
        }),
      });
    }),
  ).pipe(Layer.provide(PrivateFileAccessService.layer));
}

export const publishRegistryConfig = Effect.fn("NpmPublishConfig.registry")(function* (
  registry: string,
  packageName: string,
  kind: "basic" | "bearer",
) {
  const files = yield* NpmPublishConfigFiles;
  const auth =
    kind === "basic"
      ? 'username = "$LANDO_NPM_BASIC_USERNAME", password = "$LANDO_NPM_BASIC_PASSWORD"'
      : 'token = "$BUN_CONFIG_TOKEN"';
  const object = `{ url = ${JSON.stringify(registry)}, ${auth} }`;
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
  return yield* files.create(
    `[install]\nregistry = ${object}\n${scope === undefined ? "" : `\n[install.scopes]\n${JSON.stringify(scope)} = ${object}\n`}`,
  );
}, Effect.provide(NpmPublishConfigFiles.layer));

export const npmPublishRemoveEnv = [
  "BUN_CONFIG_TOKEN",
  "NPM_CONFIG_TOKEN",
  "npm_config_token",
  "BUN_AUTH_TOKEN",
  "BUN_CONFIG_REGISTRY",
  "NPM_CONFIG_REGISTRY",
  "npm_config_registry",
] as const;
