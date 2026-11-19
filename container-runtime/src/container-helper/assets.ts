import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { ContainerHelperUnavailableError, causeMessage } from "@lando/sdk/errors";
import { AbsolutePath, type ContainerHelperArtifact, type ContainerHelperTarget } from "@lando/sdk/schema";
import { ContainerHelperAssets, PathsService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import {
  CONTAINER_HELPER_COMMANDS,
  CONTAINER_HELPER_FILE,
  containerHelperCommandEnginePath,
  containerHelperCommandMount,
  containerHelperCommandShim,
} from "../container-helper.ts";

import { containerHelperNotices } from "./notices.ts";
import {
  CONTAINER_HELPER_SOURCE_DIGEST_PATH,
  CONTAINER_HELPER_SOURCE_ROOT,
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

const verifiedFiles = new Map<
  string,
  { readonly identity: string; readonly artifact: ContainerHelperArtifact }
>();

const fromFileIfPresent = async (
  target: ContainerHelperTarget,
  path: string,
): Promise<ContainerHelperArtifact | undefined> => {
  const info = await stat(path, { bigint: true }).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (info === undefined) return undefined;
  await chmod(dirname(path), 0o755);
  if ((Number(info.mode) & 0o777) !== 0o755) await chmod(path, 0o755);
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const cached = verifiedFiles.get(path);
  if (cached?.identity === identity) return { ...cached.artifact, target };
  const bytes = await readIfPresent(path);
  if (bytes === undefined) return undefined;
  const value = artifact(target, path, bytes);
  verifiedFiles.set(path, { identity, artifact: value });
  return value;
};

const fromFile = async (target: ContainerHelperTarget, path: string): Promise<ContainerHelperArtifact> => {
  const value = await fromFileIfPresent(target, path);
  if (value === undefined) throw new HelperResolveFailure(`Container helper not found: ${path}`);
  return value;
};

const fromSourceBuild = async (target: ContainerHelperTarget): Promise<ContainerHelperArtifact> => {
  await containerHelperNotices(join(CONTAINER_HELPER_SOURCE_ROOT, "dist"));
  const recorded = await readIfPresent(CONTAINER_HELPER_SOURCE_DIGEST_PATH);
  if (
    recorded === undefined ||
    new TextDecoder().decode(recorded).trim() !== (await containerHelperSourceDigest())
  )
    throw new HelperResolveFailure("The built container helper is missing or older than its sources.");
  return fromFile(target, containerHelperDistPath(target.arch));
};

const embeddedPattern = (target: ContainerHelperTarget): RegExp =>
  new RegExp(`^${CONTAINER_HELPER_FILE}-linux-${target.arch}-([a-f0-9]{64})(?:-[a-z0-9]+)?\\.gz$`);

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
  const cached = await fromFileIfPresent(input.target, path);
  if (cached?.digest === match.digest) {
    await chmod(dirname(dirname(path)), 0o755);
    return cached;
  }
  const bytes = gunzipSync(new Uint8Array(await match.file.arrayBuffer()));
  if (sha256Hex(bytes) !== match.digest)
    throw new HelperResolveFailure("Embedded container helper failed its checksum.");
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await chmod(dirname(path), 0o755);
  await chmod(dirname(dirname(path)), 0o755);
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

const publishContainerHelperCommand = async (helper: ContainerHelperArtifact): Promise<void> => {
  const [first] = CONTAINER_HELPER_COMMANDS;
  for (const directory of [
    dirname(containerHelperCommandMount(helper, first)),
    dirname(containerHelperCommandEnginePath(helper, first)),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
  }
  for (const name of CONTAINER_HELPER_COMMANDS) {
    await publishContainerHelperShim(containerHelperCommandMount(helper, name), name);
    await publishContainerHelperEngine(helper, name);
  }
};

/**
 * The shim is immutable content at a stable path, so it publishes only when it is
 * missing or was written by an older format; a running container keeps an
 * identical copy.
 */
const publishContainerHelperShim = async (path: string, name: string): Promise<void> => {
  const content = containerHelperCommandShim(name);
  const existing = await readIfPresent(path);
  if (existing !== undefined && new TextDecoder().decode(existing) === content) return;
  const staging = `${path}.lando-stage.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(staging, content, { flag: "wx", mode: 0o755 });
    await chmod(staging, 0o755);
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
};

/**
 * The engine link names the helper this architecture must execute. A staging hard
 * link plus rename updates it in one atomic step, so a container exec resolves a
 * complete helper and two Lando processes (or versions) racing leave one complete
 * engine behind. A filesystem without hard links falls back to a staged copy.
 */
const publishContainerHelperEngine = async (helper: ContainerHelperArtifact, name: string): Promise<void> => {
  const engine = containerHelperCommandEnginePath(helper, name);
  const [published, source] = await Promise.all([
    stat(engine, { bigint: true }).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    }),
    stat(helper.path, { bigint: true }),
  ]);
  if (published !== undefined && published.dev === source.dev && published.ino === source.ino) return;
  const staging = `${engine}.lando-stage.${process.pid}.${randomUUID()}`;
  try {
    await link(helper.path, staging).catch(async () => {
      const bytes = await readFile(helper.path);
      await writeFile(staging, bytes, { flag: "wx", mode: 0o755 });
      await chmod(staging, 0o755);
    });
    await rename(staging, engine);
  } finally {
    await rm(staging, { force: true });
  }
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
    try: async () => {
      const override = (input.env ?? process.env)[CONTAINER_HELPER_DIR_ENV];
      let artifact: ContainerHelperArtifact;
      if (override !== undefined && override.length > 0) {
        artifact = await fromFile(target, resolve(override, `linux-${target.arch}`, CONTAINER_HELPER_FILE));
      } else if (standalone) {
        artifact = await extractEmbeddedContainerHelper({
          target,
          files: input.embeddedFiles ?? embeddedFiles(),
          cacheRoot: input.cacheRoot ?? makeLandoPaths().toolDownloadsDir("container-helper"),
        });
      } else {
        artifact = await fromSourceBuild(target);
      }
      await publishContainerHelperCommand(artifact);
      return artifact;
    },
    catch: (cause) => unavailable(target, cause, standalone),
  });
};

export const layerWith = (input: Parameters<typeof resolveContainerHelper>[1] = {}) =>
  Layer.effect(
    ContainerHelperAssets,
    Effect.gen(function* () {
      const paths = yield* PathsService;
      return ContainerHelperAssets.of({
        resolve: (target) =>
          resolveContainerHelper(target, { ...input, cacheRoot: paths.toolDownloadsDir("container-helper") }),
      });
    }),
  );

export const layer = layerWith();
