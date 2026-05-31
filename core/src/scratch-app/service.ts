import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem, ScratchAppService } from "@lando/sdk/services";

import { resolveUserCacheRoot } from "../cache/paths.ts";

export { ScratchAppService } from "@lando/sdk/services";

export const SCRATCH_DIR = "scratch";

const scratchAppError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({ message, operation, cause });

const sanitizeBase = (base: string): string => {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned.length === 0 ? "scratch" : cleaned;
};

// Security: reject ids that `join` could use to escape `<userCacheRoot>/scratch/<id>/`
// (spec §21.3) — path separators, NUL, or a pure-dot segment (`.`, `..`).
const isUnsafeScratchId = (id: string): boolean =>
  id.length === 0 || /[/\\\0]/u.test(id) || /^\.+$/u.test(id);

const makeScratchAppService = (
  fileSystem: Context.Tag.Service<typeof FileSystem>,
): Context.Tag.Service<typeof ScratchAppService> => {
  const root = Effect.sync(() => AbsolutePath.make(join(resolveUserCacheRoot(), SCRATCH_DIR)));

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem.mkdir(path).pipe(
        Effect.as(path),
        Effect.mapError((cause) =>
          scratchAppError("ensureRoot", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      ),
    ),
  );

  const synthesizeId = (base: string) =>
    Effect.sync(() => {
      const suffix = createHash("sha256")
        .update(`${base}:${Date.now()}:${process.pid}:${randomBytes(8).toString("hex")}`)
        .digest("hex")
        .slice(0, 6);
      return `scratch-${sanitizeBase(base)}-${suffix}`;
    });

  const paths = (id: string) =>
    isUnsafeScratchId(id)
      ? Effect.fail(
          scratchAppError("paths", `Refusing to resolve scratch paths for unsafe id "${id}".`, undefined),
        )
      : root.pipe(
          Effect.map((base) => {
            const instanceRoot = AbsolutePath.make(join(base, id));
            return {
              base,
              instanceRoot,
              root: AbsolutePath.make(join(instanceRoot, "root")),
              planCache: AbsolutePath.make(join(instanceRoot, "plan.bin")),
              infoCache: AbsolutePath.make(join(instanceRoot, "info.json")),
              buildResults: AbsolutePath.make(join(instanceRoot, "build-results.bin")),
            };
          }),
        );

  return { kind: "scratch", root, ensureRoot, synthesizeId, paths };
};

export const ScratchAppServiceLive = Layer.effect(
  ScratchAppService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    return makeScratchAppService(fileSystem);
  }),
);
