import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { Effect } from "effect";

import { assertUnderRoot } from "@lando/landofile/include-guard";
import { LandofileValidationError } from "@lando/sdk/errors";

export interface ServiceConfigSource {
  readonly key: "server" | "dir";
  readonly authored: string;
  readonly source: string;
  readonly digest: string;
}

export const resolveServiceConfigSources = (input: {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly config: { readonly server?: string | undefined; readonly dir?: string | undefined } | undefined;
}): Effect.Effect<ReadonlyArray<ServiceConfigSource>, LandofileValidationError> =>
  Effect.gen(function* () {
    const sources: ServiceConfigSource[] = [];
    for (const key of ["server", "dir"] as const) {
      const authored = input.config?.[key];
      if (authored === undefined) continue;
      const issue = `services.${input.serviceName}.config.${key}`;
      const validationError = (message: string): LandofileValidationError =>
        new LandofileValidationError({
          message: `${issue} ${message}`,
          file: `${input.appRoot}/.lando.yml`,
          issues: [issue],
        });
      const io = <A>(path: string, operation: () => Promise<A>): Effect.Effect<A, LandofileValidationError> =>
        Effect.tryPromise({
          try: operation,
          catch: () =>
            validationError(
              `path ${path} is missing, unreadable, or a dangling symlink. Create a readable source inside the app and repair any broken symlinks.`,
            ),
        });
      const contained = (path: string, entry: string): Effect.Effect<string, LandofileValidationError> =>
        Effect.tryPromise({
          try: () => assertUnderRoot(input.appRoot, path, entry),
          catch: () =>
            validationError(
              `path ${entry} must stay inside the app root. Move the source inside the app and use a path relative to the app root.`,
            ),
        });
      const fileDigest = (path: string, entry: string): Effect.Effect<string, LandofileValidationError> =>
        io(entry, () => readFile(path)).pipe(
          Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
        );

      if (isAbsolute(authored) || authored.startsWith("~")) {
        return yield* Effect.fail(
          validationError(
            `path ${authored} must not be absolute or start with ~. Use a path relative to the app root.`,
          ),
        );
      }
      const source = yield* contained(resolve(input.appRoot, authored), authored);
      const sourceStat = yield* io(authored, () => stat(source));
      const expectedKind = { server: "regular file", dir: "directory" } as const;
      const correctKind = { server: sourceStat.isFile(), dir: sourceStat.isDirectory() };
      if (!correctKind[key]) {
        return yield* Effect.fail(
          validationError(
            `path ${authored} must be a ${expectedKind[key]}. Use a readable ${expectedKind[key]} inside the app root.`,
          ),
        );
      }

      const walk = (
        directory: string,
        relativeDirectory: string,
        ancestors: ReadonlyArray<string>,
      ): Effect.Effect<ReadonlyArray<string>, LandofileValidationError> =>
        Effect.gen(function* () {
          const entries = yield* io(relativeDirectory || authored, () =>
            readdir(directory, { withFileTypes: true }),
          );
          const records: string[] = [];
          for (const entry of entries) {
            const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const candidate = join(directory, entry.name);
            const canonical = yield* io(relativeEntry, () => realpath(candidate));
            const path = yield* contained(canonical, relativeEntry);
            const entryStat = yield* io(relativeEntry, () => stat(path));
            if (entryStat.isDirectory()) {
              if (ancestors.includes(path)) {
                return yield* Effect.fail(
                  validationError(
                    `entry ${relativeEntry} creates a directory symlink cycle. Remove the cyclic link and use a directory inside the app.`,
                  ),
                );
              }
              records.push(...(yield* walk(path, relativeEntry, [...ancestors, path])));
            } else if (entryStat.isFile()) {
              const digest = yield* fileDigest(path, relativeEntry);
              records.push(`${relativeEntry}\0${digest}\n`);
            } else {
              return yield* Effect.fail(
                validationError(
                  `entry ${relativeEntry} is not a regular file or directory. Replace it with a readable file or directory inside the app.`,
                ),
              );
            }
          }
          return records;
        });

      const digest = yield* {
        server: () => fileDigest(source, authored),
        dir: () =>
          walk(source, "", [source]).pipe(
            Effect.map((records) =>
              createHash("sha256")
                .update([...records].sort().join(""))
                .digest("hex"),
            ),
          ),
      }[key]();
      sources.push({ key, authored, source, digest });
    }
    return sources;
  });
