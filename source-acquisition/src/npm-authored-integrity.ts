import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { SourceAcquisitionError, acquisitionError } from "./errors.ts";
import { containedPath } from "./tree.ts";
import type { NpmAuthoredIntegrity } from "./types.ts";

export const verifyAuthoredNpmDigest = (source: string, expected: NpmAuthoredIntegrity, actual: string) =>
  actual === expected.hex.toLowerCase()
    ? Effect.void
    : Effect.fail(
        new SourceAcquisitionError({
          source,
          kind: "integrity-mismatch",
          message: `Authored ${expected.algorithm} digest mismatch for ${source} (${expected.file ?? "npm tarball"}).`,
          remediation:
            "Check the published bytes and correct the project package-manager pin before retrying.",
        }),
      );

export const verifyNpmFile = (source: string, expected: NpmAuthoredIntegrity & { readonly file: string }) =>
  Effect.fnUntraced(function* (root: string) {
    const actual = yield* Effect.tryPromise({
      try: async () => {
        const path = containedPath(root, "package", expected.file);
        if ((await realpath(dirname(path))) !== dirname(path)) {
          throw new TypeError("Expected a regular file within the npm tree.");
        }
        await using handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!(await handle.stat()).isFile())
          throw new TypeError("Expected a regular file within the npm tree.");
        const hash = createHash(expected.algorithm);
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new RangeError("Npm integrity file exceeds 32 MiB.");
          hash.update(chunk);
        }
        return hash.digest("hex");
      },
      catch: (cause) => acquisitionError("integrity-mismatch", source, cause),
    });
    yield* verifyAuthoredNpmDigest(source, expected, actual);
  });
