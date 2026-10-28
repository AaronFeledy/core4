import { createHash } from "node:crypto";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";
import { Effect, Option, Schema, Semaphore, Stream } from "effect";
import { CONTAINER_HELPER_FILE } from "./container-helper.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { apiResponseFailure, missingApi } from "./engine-errors.ts";
import { archiveLogFileHelper } from "./log-file-archive.ts";
import { TAR_BLOCK_SIZE, padToBlock } from "./tar.ts";

interface HelperArtifact {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

const decoder = new TextDecoder();
const missingArchive = Schema.Struct({ status: Schema.Literal(404) });
// Serialize only installation, never execution. Every caller still verifies the container bytes.
const locks = new WeakMap<EngineHttpApi, Semaphore.Semaphore>();
const text = (header: Uint8Array, start: number, length: number): string =>
  decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/su, "");

const octal = (header: Uint8Array, start: number, length: number): number => {
  const value = text(header, start, length).trim();
  return /^[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : Number.NaN;
};

/** Read only the two entry forms emitted by our helper archive, never a general tar extractor. */
const headerMetadata = (header: Uint8Array) => {
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  return {
    valid:
      header.length === TAR_BLOCK_SIZE &&
      checksum === octal(header, 148, 8) &&
      text(header, 257, 6) === "ustar" &&
      text(header, 345, 155) === "" &&
      text(header, 157, 100) === "",
    name: text(header, 0, 100),
    uid: octal(header, 108, 8),
    mode: octal(header, 100, 8),
    size: octal(header, 124, 12),
    type: header[156],
  };
};

const trustedArchive = (archive: Uint8Array, directory: string, artifact: HelperArtifact): boolean => {
  if (archive.length % TAR_BLOCK_SIZE !== 0) return false;
  let offset = 0;
  let directorySeen = false;
  let fileSeen = false;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      return (
        directorySeen &&
        fileSeen &&
        archive.length - offset >= TAR_BLOCK_SIZE * 2 &&
        archive.subarray(offset).every((byte) => byte === 0)
      );
    }
    const entry = headerMetadata(header);
    if (!entry.valid || entry.uid !== 0 || entry.mode !== 0o755 || !Number.isSafeInteger(entry.size))
      return false;
    offset += TAR_BLOCK_SIZE;
    if (entry.name === `${directory}/` && entry.type === 53 && entry.size === 0 && !directorySeen) {
      directorySeen = true;
    } else if (
      entry.name === `${directory}/${CONTAINER_HELPER_FILE}` &&
      entry.type === 48 &&
      entry.size === artifact.bytes.length &&
      !fileSeen
    ) {
      const end = offset + entry.size;
      if (
        end > archive.length ||
        createHash("sha256").update(archive.subarray(offset, end)).digest("hex") !== artifact.digest
      )
        return false;
      if (!archive.subarray(end, end + padToBlock(entry.size)).every((byte) => byte === 0)) return false;
      offset = end + padToBlock(entry.size);
      fileSeen = true;
    } else return false;
  }
  return false;
};

const oneChunk = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

/** Container-owned content-addressed cache; execution must follow a fresh authoritative readback. */
export const installExecHelper = (
  api: EngineHttpApi,
  ctx: ProviderErrorContext,
  containerId: string,
  artifact: HelperArtifact,
): Effect.Effect<string, ProviderError> =>
  Effect.suspend(() => {
    let lock = locks.get(api);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(api, lock);
    }
    return lock.withPermits(1)(
      Effect.gen(function* () {
        const failure = (reason: string) =>
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "exec.installHelper",
            message: `Cannot safely install the container exec helper (${reason}).`,
            remediation: "Recreate the service container, then retry the command.",
          });
        const request = api.request;
        const stream = api.stream;
        if (request === undefined || stream === undefined)
          return yield* Effect.fail(missingApi(ctx, "exec.installHelper"));
        if (
          !/^[a-f0-9]{64}$/u.test(artifact.digest) ||
          artifact.bytes.length === 0 ||
          createHash("sha256").update(artifact.bytes).digest("hex") !== artifact.digest
        ) {
          return yield* Effect.fail(failure("artifact-digest"));
        }
        const container = encodeURIComponent(containerId);
        const directory = `lando-exec-${artifact.digest}`;
        const path = `/tmp/${directory}`;
        // Stop after the first header: never collect the recursively archived contents of /tmp.
        let prefixLength = 0;
        const prefix: Uint8Array[] = [];
        yield* stream({ method: "GET", path: `/containers/${container}/archive?path=/tmp` }).pipe(
          Stream.map((chunk) => {
            const part = chunk.subarray(0, TAR_BLOCK_SIZE - prefixLength);
            prefix.push(part);
            prefixLength += part.length;
            return prefixLength;
          }),
          Stream.takeUntil((length) => length === TAR_BLOCK_SIZE),
          Stream.runDrain,
        );
        const tmpHeader = new Uint8Array(prefixLength);
        let prefixOffset = 0;
        for (const part of prefix) {
          tmpHeader.set(part, prefixOffset);
          prefixOffset += part.length;
        }
        const tmp = headerMetadata(tmpHeader);
        if (
          !tmp.valid ||
          tmp.name !== "tmp/" ||
          tmp.type !== 53 ||
          tmp.size !== 0 ||
          tmp.uid !== 0 ||
          (tmp.mode !== 0o1777 && tmp.mode !== 0o755)
        )
          return yield* Effect.fail(failure("unsafe-tmp-directory"));

        const verify = Effect.gen(function* () {
          let length = 0;
          const chunks: Uint8Array[] = [];
          // Two headers, alignment, end markers, and bounded provider record padding.
          const limit = artifact.bytes.length + 32 * 1024;
          const found = yield* stream({
            method: "GET",
            path: `/containers/${container}/archive?path=${encodeURIComponent(path)}`,
          }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                length += chunk.length;
                if (length > limit) return yield* Effect.fail(failure("archive-limit"));
                chunks.push(chunk);
              }),
            ),
            Effect.as(true),
            Effect.catch((error) =>
              error instanceof ProviderUnavailableError &&
              length === 0 &&
              Option.isSome(Schema.decodeUnknownOption(missingArchive)(error.details))
                ? Effect.succeed(false)
                : Effect.fail(error),
            ),
          );
          if (!found) return false;
          const archive = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            archive.set(chunk, offset);
            offset += chunk.length;
          }
          if (!trustedArchive(archive, directory, artifact))
            return yield* Effect.fail(failure("untrusted-existing-helper"));
          return true;
        });
        if (!(yield* verify)) {
          const response = yield* request({
            method: "PUT",
            path: `/containers/${container}/archive?path=/tmp&noOverwriteDirNonDir=true`,
            headers: { "Content-Type": "application/x-tar" },
            stdin: oneChunk(archiveLogFileHelper(artifact.bytes, directory)),
          });
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              apiResponseFailure(
                ctx,
                "exec.installHelper",
                response,
                "The provider could not install the container exec helper.",
              ),
            );
          if (!(yield* verify)) return yield* Effect.fail(failure("installed-helper-missing"));
        }
        return `${path}/${CONTAINER_HELPER_FILE}`;
      }),
    );
  });
