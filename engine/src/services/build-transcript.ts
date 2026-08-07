import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

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
  userDataRoot: string,
): Effect.Effect<BuildTranscript, ProviderInternalError, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = dirname(path);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const [canonicalDirectory, canonicalUserDataRoot] = await Promise.all([
          realpath(directory),
          realpath(userDataRoot),
        ]);
        const userDataPrefix = canonicalUserDataRoot.endsWith(sep)
          ? canonicalUserDataRoot
          : `${canonicalUserDataRoot}${sep}`;
        if (canonicalDirectory !== canonicalUserDataRoot && !canonicalDirectory.startsWith(userDataPrefix)) {
          throw transcriptError(providerId, path, "Transcript directory escapes the user data root.");
        }
        if (process.platform === "win32") {
          try {
            if ((await lstat(path)).isSymbolicLink()) {
              throw transcriptError(providerId, path, "Final path is a symbolic link.");
            }
          } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
              throw cause;
            }
          }
        }

        const flags =
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
        const file = await open(path, flags, 0o600);
        try {
          if (process.platform !== "win32") await file.chmod(0o600);
          return { file, writer: Bun.file(file.fd).writer() };
        } catch (cause) {
          await file.close();
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof ProviderInternalError ? cause : transcriptError(providerId, path, cause),
    }),
    ({ file, writer }) =>
      Effect.promise(async () => {
        try {
          await writer.end();
        } finally {
          await file.close();
        }
      }),
  ).pipe(
    Effect.map(({ writer }) => ({
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
