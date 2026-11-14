import { Buffer } from "node:buffer";
import { type Stats, constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { BuildOwner } from "./build-owner.ts";

const READ_CHUNK_BYTES = 8192;

export interface BuildTranscript {
  readonly append: (chunk: Uint8Array) => Effect.Effect<void, ProviderInternalError>;
}

interface BuildTranscriptLocationInput {
  readonly userDataRoot: string;
  readonly owner: BuildOwner;
}

interface BuildTranscriptPhaseInput extends BuildTranscriptLocationInput {
  readonly phase: "artifact" | "app";
}

interface BuildTranscriptPathInput extends BuildTranscriptPhaseInput {
  readonly serviceName: string;
  readonly buildKey: string;
}

export interface ReadBuildTranscriptLinesInput {
  readonly providerId: string;
  /** The user data root; a transcript whose app directory resolves outside it is never read. */
  readonly userDataRoot: string;
  /** The app directory under `builds/`; a transcript outside it is never read. */
  readonly appDir: string;
  readonly path: AbsolutePath;
  /** Read only the last N lines, backwards in chunks. */
  readonly tail?: number;
}

const safePathSegment = (value: string): string =>
  /^[A-Za-z0-9_-]+$/u.test(value) ? value : `~${Buffer.from(value).toString("base64url")}`;

export const makeBuildTranscriptAppDir = (input: BuildTranscriptLocationInput): AbsolutePath =>
  AbsolutePath.make(
    join(
      input.userDataRoot,
      "builds",
      input.owner.kind === "scratch" ? "scratch" : "owners",
      safePathSegment(input.owner.key),
    ),
  );

export const makeBuildTranscriptPhaseDir = (input: BuildTranscriptPhaseInput): AbsolutePath =>
  AbsolutePath.make(join(makeBuildTranscriptAppDir(input), input.phase));

export const makeBuildTranscriptPath = (input: BuildTranscriptPathInput): AbsolutePath =>
  AbsolutePath.make(
    join(
      makeBuildTranscriptPhaseDir(input),
      safePathSegment(input.serviceName),
      `${safePathSegment(input.buildKey)}.log`,
    ),
  );

/** Shared containment predicate: a real path is usable only inside the real user data root. */
export const isWithinUserDataRoot = (canonicalUserDataRoot: string, canonicalPath: string): boolean => {
  if (canonicalPath === canonicalUserDataRoot) return true;
  const prefix = canonicalUserDataRoot.endsWith(sep)
    ? canonicalUserDataRoot
    : `${canonicalUserDataRoot}${sep}`;
  return canonicalPath.startsWith(prefix);
};

const REPORT_REMEDIATION =
  "Re-run the command after checking provider logs; if it persists, report the internal provider error.";

const TRANSCRIPT_FAILURES = {
  write: {
    message: (path: string) => `Unable to write build transcript ${path}.`,
    remediation: REPORT_REMEDIATION,
  },
  read: {
    message: (path: string) => `Unable to read build transcript ${path}.`,
    remediation: 'Check that the file is readable, or run "lando rebuild" to record the build output again.',
  },
  remove: {
    message: (path: string) => `Unable to remove build output at ${path}.`,
    remediation: REPORT_REMEDIATION,
  },
} as const;

export const buildTranscriptError = (
  providerId: string,
  path: AbsolutePath,
  cause: unknown,
  action: keyof typeof TRANSCRIPT_FAILURES = "write",
) =>
  new ProviderInternalError({
    providerId,
    operation: "buildTranscript",
    message: TRANSCRIPT_FAILURES[action].message(path),
    cause,
    remediation: TRANSCRIPT_FAILURES[action].remediation,
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
        if (!isWithinUserDataRoot(canonicalUserDataRoot, canonicalDirectory)) {
          throw buildTranscriptError(providerId, path, "Transcript directory escapes the user data root.");
        }
        if (process.platform === "win32") {
          try {
            if ((await lstat(path)).isSymbolicLink()) {
              throw buildTranscriptError(providerId, path, "Final path is a symbolic link.");
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
        cause instanceof ProviderInternalError ? cause : buildTranscriptError(providerId, path, cause),
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
          catch: (cause) => buildTranscriptError(providerId, path, cause),
        }),
    })),
  );

/** A recorded transcript is advertised only while a regular file is still there. */
export const buildTranscriptExists = (path: AbsolutePath): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      return (await lstat(path)).isFile();
    } catch {
      return false;
    }
  });

export const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/**
 * A window of bytes ending at the end of the file that starts on a line boundary and holds at
 * least its last `limit` lines; the whole file when `limit` is undefined. It reads backwards in
 * chunks and stops once the window holds those lines, so a tail never loads the whole file.
 */
export const readTailBytes = async (
  readAt: (position: number, length: number) => Promise<Buffer>,
  size: number,
  limit: number | undefined,
  chunkBytes = READ_CHUNK_BYTES,
): Promise<Buffer> => {
  let position = size;
  let newlines = 0;
  const chunks: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(chunkBytes, position);
    position -= length;
    const buffer = await readAt(position, length);
    for (const byte of buffer) if (byte === 0x0a) newlines += 1;
    chunks.push(buffer);
    // Once the window holds the separator before the first retained line, more data cannot
    // change the last `limit` lines.
    if (limit !== undefined && newlines > limit) break;
  }
  const data = Buffer.concat(chunks.reverse());
  if (limit === undefined) return data;
  // Keep only what follows the (limit + 1)th newline from the end. A newline byte never occurs
  // inside a multi-byte UTF-8 sequence, so cutting here cannot split a character.
  let remaining = limit + 1;
  for (let index = data.length - 1; index >= 0; index -= 1) {
    if (data[index] !== 0x0a) continue;
    remaining -= 1;
    if (remaining === 0) return data.subarray(index + 1);
  }
  return data;
};

/**
 * Read a transcript's lines, optionally only the last `tail`. A missing path, a symlink, or a
 * path outside the app's directory yields `undefined` instead of an error: an advertised
 * transcript that no longer resolves is skipped, never followed.
 */
export const readBuildTranscriptLines = (
  input: ReadBuildTranscriptLinesInput,
): Effect.Effect<ReadonlyArray<string> | undefined, ProviderInternalError> =>
  Effect.tryPromise({
    try: async () => {
      let info: Stats;
      try {
        info = await lstat(input.path);
      } catch (cause) {
        if (isMissing(cause)) return undefined;
        throw cause;
      }
      if (!info.isFile()) return undefined;
      const [canonicalPath, canonicalAppDir, canonicalUserDataRoot] = await Promise.all([
        realpath(input.path),
        realpath(input.appDir),
        realpath(input.userDataRoot),
      ]).catch((cause) => {
        if (isMissing(cause)) return [undefined, undefined, undefined] as const;
        throw cause;
      });
      if (canonicalPath === undefined || canonicalAppDir === undefined || canonicalUserDataRoot === undefined)
        return undefined;
      // Both links of the chain must stay inside the data root: a replaced app directory would
      // otherwise make the recorded path and the app directory agree while both resolve outside.
      if (!isWithinUserDataRoot(canonicalUserDataRoot, canonicalAppDir)) return undefined;
      if (!isWithinUserDataRoot(canonicalAppDir, canonicalPath)) return undefined;

      const limit = input.tail === undefined ? undefined : Math.max(0, Math.trunc(input.tail));
      if (limit === 0) return [];
      // The checks above ran on the path; refusing a final symlink at open closes the gap between them.
      const handle = await open(
        input.path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const { size } = await handle.stat();
        const data = await readTailBytes(
          async (position, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new Error(`Short read from ${input.path}`);
            return buffer;
          },
          size,
          limit,
        );
        const lines = data.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        return limit === undefined ? lines : lines.slice(-limit);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => buildTranscriptError(input.providerId, input.path, cause, "read"),
  });
