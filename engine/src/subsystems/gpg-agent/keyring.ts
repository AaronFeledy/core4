import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { GpgAgentTransportError, GpgAgentUnavailableError } from "@lando/sdk/errors";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

export const exportPublicKeyring = (options: {
  readonly runner: Pick<ProcessRunner["Type"], "streamWithExit">;
  readonly destDir: string;
}) => {
  const ioError = () =>
    new GpgAgentTransportError({
      message: "Unable to publish the GPG public keyring.",
      stage: "broker",
      remediation: "Check permissions on the app relay directory and retry lando start.",
    });
  const unavailable = () =>
    new GpgAgentUnavailableError({
      message: "GnuPG could not export the public keyring.",
      reason: "gpg-missing",
      remediation: "Install GnuPG and check `gpg --batch --export` before restarting the app.",
    });
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(options.destDir, { recursive: true, mode: 0o711 });
        await chmod(options.destDir, 0o711);
      },
      catch: ioError,
    });
    const exports = [
      { flag: "--export", name: "pubring.gpg" },
      { flag: "--export-ownertrust", name: "otrust.txt" },
    ];
    for (const { flag, name } of exports) {
      const temporary = join(options.destDir, `.${name}.${randomUUID()}`);
      yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            await Bun.write(temporary, new Uint8Array());
            await chmod(temporary, 0o644);
            return Bun.file(temporary).writer();
          },
          catch: ioError,
        }),
        (writer) =>
          Effect.gen(function* () {
            let successful = false;
            yield* options.runner
              .streamWithExit({ cmd: "gpg", args: ["--batch", flag], timeoutMs: 30_000 })
              .pipe(
                Stream.mapError(unavailable),
                Stream.runForEach(
                  (event): Effect.Effect<void, GpgAgentUnavailableError | GpgAgentTransportError> => {
                    if ("exitCode" in event) {
                      successful = event.exitCode === 0;
                      return successful ? Effect.void : Effect.fail(unavailable());
                    }
                    switch (event.kind) {
                      case "stdout":
                        return Effect.tryPromise({
                          try: async () => {
                            await writer.write(event.chunk);
                          },
                          catch: ioError,
                        });
                      case "stderr":
                        return Effect.void;
                      default:
                        return event.kind satisfies never;
                    }
                  },
                ),
              );
            if (successful === false) return yield* Effect.fail(unavailable());
            yield* Effect.tryPromise({
              try: async () => {
                await writer.flush();
                await rename(temporary, join(options.destDir, name));
              },
              catch: ioError,
            });
          }),
        (writer) =>
          Effect.promise(async () => {
            await writer.end();
            await rm(temporary, { force: true });
          }),
      );
    }
  });
};
