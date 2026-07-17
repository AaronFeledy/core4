import { Buffer } from "node:buffer";
import { join } from "node:path";

import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";

export interface BuildTranscript {
  readonly append: (chunk: Uint8Array) => Effect.Effect<void, ProviderInternalError>;
}

interface BuildTranscriptPathInput {
  readonly userDataRoot: string;
  readonly appId: string;
  readonly phase: "artifact" | "app";
  readonly serviceName: string;
  readonly buildKey: string;
  readonly scratch: boolean;
}

const safePathSegment = (value: string): string =>
  /^[A-Za-z0-9_-]+$/u.test(value) ? value : `~${Buffer.from(value).toString("base64url")}`;

export const makeBuildTranscriptPath = (input: BuildTranscriptPathInput): AbsolutePath =>
  AbsolutePath.make(
    join(
      input.userDataRoot,
      "builds",
      ...(input.scratch ? ["scratch"] : []),
      safePathSegment(input.appId),
      input.phase,
      safePathSegment(input.serviceName),
      `${safePathSegment(input.buildKey)}.log`,
    ),
  );

const transcriptError = (providerId: string, path: AbsolutePath, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildTranscript",
    message: `Unable to write build transcript ${path}.`,
    cause,
  });

export const openBuildTranscript = (
  providerId: string,
  path: AbsolutePath,
): Effect.Effect<BuildTranscript, ProviderInternalError, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await Bun.write(path, "");
        return Bun.file(path).writer();
      },
      catch: (cause) => transcriptError(providerId, path, cause),
    }),
    (writer) =>
      Effect.promise(async () => {
        await writer.end();
      }),
  ).pipe(
    Effect.map((writer) => ({
      append: (chunk) =>
        Effect.tryPromise({
          try: async () => {
            await writer.write(chunk);
            await writer.flush();
          },
          catch: (cause) => transcriptError(providerId, path, cause),
        }),
    })),
  );
