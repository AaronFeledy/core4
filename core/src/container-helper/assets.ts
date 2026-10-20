import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { CONTAINER_HELPER_FILE } from "@lando/container-runtime/container-helper";
import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { ContainerHelperUnavailableError, causeMessage } from "@lando/sdk/errors";
import { AbsolutePath, type ContainerHelperArtifact, type ContainerHelperTarget } from "@lando/sdk/schema";
import { ContainerHelperAssets } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

import {
  CONTAINER_HELPER_SOURCE_DIGEST_PATH,
  containerHelperDistPath,
  containerHelperSourceDigest,
} from "./source.ts";

export const CONTAINER_HELPER_DIR_ENV = "LANDO_CONTAINER_HELPER_DIR";

export type EmbeddedHelperFile = Blob & { readonly name: string };

class HelperResolveFailure extends Error {}

const readIfPresent = async (path: string): Promise<Uint8Array | undefined> => {
  try {
    return await readFile(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

const artifact = (
  target: ContainerHelperTarget,
  path: string,
  bytes: Uint8Array,
): ContainerHelperArtifact => ({
  target,
  digest: sha256Hex(bytes),
  path: AbsolutePath.make(path),
});

const fromFile = async (target: ContainerHelperTarget, path: string): Promise<ContainerHelperArtifact> => {
  const bytes = await readIfPresent(path);
  if (bytes === undefined) throw new HelperResolveFailure(`Container helper not found: ${path}`);
  return artifact(target, path, bytes);
};

const fromSourceBuild = async (target: ContainerHelperTarget): Promise<ContainerHelperArtifact> => {
  const recorded = await readIfPresent(CONTAINER_HELPER_SOURCE_DIGEST_PATH);
  if (
    recorded === undefined ||
    new TextDecoder().decode(recorded).trim() !== (await containerHelperSourceDigest())
  )
    throw new HelperResolveFailure("The built container helper is missing or older than its sources.");
  return fromFile(target, containerHelperDistPath(target.arch));
};

const embeddedPattern = (target: ContainerHelperTarget): RegExp =>
  new RegExp(`^lando-container-helper-linux-${target.arch}-([a-f0-9]{64})(?:-[a-z0-9]+)?\\.gz$`);

/** Extracts the embedded helper once per digest into the user cache and verifies it. */
export const extractEmbeddedContainerHelper = async (input: {
  readonly target: ContainerHelperTarget;
  readonly files: ReadonlyArray<EmbeddedHelperFile>;
  readonly cacheRoot: string;
}): Promise<ContainerHelperArtifact> => {
  const pattern = embeddedPattern(input.target);
  const matches = input.files.flatMap((file) => {
    const digest = pattern.exec(file.name)?.[1];
    return digest === undefined ? [] : [{ file, digest }];
  });
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new HelperResolveFailure("Expected exactly one embedded container helper for this architecture.");
  const path = join(input.cacheRoot, `linux-${input.target.arch}`, match.digest, CONTAINER_HELPER_FILE);
  const cached = await readIfPresent(path);
  if (cached !== undefined && sha256Hex(cached) === match.digest) return artifact(input.target, path, cached);
  const bytes = gunzipSync(new Uint8Array(await match.file.arrayBuffer()));
  if (sha256Hex(bytes) !== match.digest)
    throw new HelperResolveFailure("Embedded container helper failed its checksum.");
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.lando-stage.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(staging, bytes, { flag: "wx", mode: 0o755 });
    await chmod(staging, 0o755);
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
  return artifact(input.target, path, bytes);
};

const embeddedFiles = (): ReadonlyArray<EmbeddedHelperFile> =>
  Bun.embeddedFiles.flatMap((file) =>
    "name" in file && typeof file.name === "string" ? [Object.assign(file, { name: file.name })] : [],
  );

const unavailable = (target: ContainerHelperTarget, cause: unknown, standalone: boolean) =>
  new ContainerHelperUnavailableError({
    target,
    message: causeMessage(cause),
    remediation: standalone
      ? "Reinstall Lando. Its embedded container helper is missing or damaged."
      : "Run `bun run --filter='@lando/core' build:container-helper` to build it with Lando, or point LANDO_CONTAINER_HELPER_DIR at prebuilt binaries.",
    ...(cause instanceof HelperResolveFailure ? {} : { cause }),
  });

/**
 * Resolves the helper executable for a container target:
 * `LANDO_CONTAINER_HELPER_DIR/linux-<arch>/lando-container-helper` when set, the
 * embedded copy in a compiled binary, otherwise the source build in
 * `core/container-helper/dist` (which must match the current sources).
 */
export const resolveContainerHelper = (
  target: ContainerHelperTarget,
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly standalone?: boolean;
    readonly embeddedFiles?: ReadonlyArray<EmbeddedHelperFile>;
    readonly cacheRoot?: string;
  } = {},
): Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError> => {
  const standalone = input.standalone ?? Bun.isStandaloneExecutable;
  return Effect.tryPromise({
    try: () => {
      const override = (input.env ?? process.env)[CONTAINER_HELPER_DIR_ENV];
      if (override !== undefined && override.length > 0)
        return fromFile(target, resolve(override, `linux-${target.arch}`, CONTAINER_HELPER_FILE));
      if (!standalone) return fromSourceBuild(target);
      return extractEmbeddedContainerHelper({
        target,
        files: input.embeddedFiles ?? embeddedFiles(),
        cacheRoot: input.cacheRoot ?? makeLandoPaths().toolDownloadsDir("container-helper"),
      });
    },
    catch: (cause) => unavailable(target, cause, standalone),
  });
};

export const layer = Layer.succeed(
  ContainerHelperAssets,
  ContainerHelperAssets.of({ resolve: (target) => resolveContainerHelper(target) }),
);
