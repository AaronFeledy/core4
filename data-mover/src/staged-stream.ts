import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect, type Scope, type Stream } from "effect";

import {
  type VerifiedStreamError,
  type VerifiedStreamResult,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";

export type StagedStream = {
  readonly path: string;
  readonly verified: VerifiedStreamResult;
};

export type StageStreamInput<E, R> = {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly scratchDir: string;
  readonly prefix: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
};

export const stageVerifiedStream = Effect.fnUntraced(function* <E, R>(
  input: StageStreamInput<E, R>,
): Effect.fn.Return<StagedStream, E | VerifiedStreamError, Scope.Scope | R> {
  const path = join(input.scratchDir, `.lando-stage-${input.prefix}-${randomUUID()}`);
  yield* Effect.addFinalizer(() => Effect.promise(() => unlink(path).catch(() => undefined)));
  const verified = yield* persistVerifiedStream({
    body: input.body,
    destinationPath: path,
    ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
    ...(input.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: input.expectedSizeBytes }),
  });
  return { path, verified };
});
