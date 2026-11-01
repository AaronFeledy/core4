import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Option } from "effect";
import { verifyHostProxyRunDirectory } from "./run-directory.ts";

interface SessionCredentials {
  readonly app: string;
  readonly session: string;
  readonly token: string;
}

export const writeHostProxyCredentials = (
  directory: string,
  credentials: SessionCredentials,
): Effect.Effect<void, HostProxyTransportUnavailableError> => {
  const write = Effect.gen(function* () {
    const access = yield* PrivateFileAccessService;
    yield* Effect.tryPromise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await verifyHostProxyRunDirectory(directory);
      await access.enforce(directory);
      await access.verify(directory);
      await writeFileAtomic(join(directory, "credentials"), JSON.stringify({ version: 1, ...credentials }), {
        mode: 0o444,
      });
    });
  });
  return Effect.gen(function* () {
    const access = yield* Effect.serviceOption(PrivateFileAccessService);
    yield* Option.isSome(access)
      ? write.pipe(Effect.provideService(PrivateFileAccessService, access.value))
      : Effect.scoped(write.pipe(Effect.provide(PrivateFileAccessService.layer)));
  }).pipe(
    Effect.mapError(
      () =>
        new HostProxyTransportUnavailableError({
          message: "Cannot prepare private host-proxy credentials.",
          socketPath: directory,
          remediation: "Ensure the host-proxy run directory is owned by you with private access, then retry.",
        }),
    ),
  );
};
