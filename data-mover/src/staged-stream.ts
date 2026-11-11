import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { DataTransferError } from "@lando/sdk/errors";
import {
  type VerifiedStreamError,
  type VerifiedStreamResult,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, type Scope, type Stream } from "effect";

export type StagedStream = {
  readonly path: string;
  readonly verified: VerifiedStreamResult;
};

export type StageStreamInput<E, R> = {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly transferStagingDir: string;
  readonly prefix: string;
  readonly privateFileAccess: PrivateFileAccess;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
};

export const stageVerifiedStream = Effect.fnUntraced(function* <E, R>(
  input: StageStreamInput<E, R>,
): Effect.fn.Return<StagedStream, E | VerifiedStreamError | DataTransferError, Scope.Scope | R> {
  const preparePrivateFile = async (path: string): Promise<void> => {
    await input.privateFileAccess.enforce(path);
    await input.privateFileAccess.verify(path);
  };
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(input.transferStagingDir, { recursive: true, mode: 0o700 });
      await chmod(input.transferStagingDir, 0o700);
      await preparePrivateFile(input.transferStagingDir);
    },
    catch: (cause) =>
      new DataTransferError({
        operation: "stage",
        message: "Failed to secure the transfer staging directory.",
        cause,
        remediation: "Check owner-only access to the transfer staging directory and retry.",
      }),
  });
  const path = join(input.transferStagingDir, `.lando-stage-${input.prefix}-${randomUUID()}`);
  yield* Effect.addFinalizer(() => Effect.promise(() => unlink(path).catch(() => undefined)));
  const verified = yield* persistVerifiedStream({
    body: input.body,
    destinationPath: path,
    mode: 0o600,
    beforeWrite: preparePrivateFile,
    ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
    ...(input.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: input.expectedSizeBytes }),
  });
  return { path, verified };
});
