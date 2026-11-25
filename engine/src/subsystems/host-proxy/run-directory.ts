import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode } from "@lando/sdk/errors";
import { PrivateFileAccessError } from "@lando/state-store/private-file-access";

/**
 * Subdirectory of an app's private host-proxy run directory that containers bind. It holds only
 * container-facing files (the local socket and the session credentials) and its generation; the
 * control token, worker record, and shim stay in the private parent. Every session publishes into
 * the same directory, so a running container reaches a replacement worker without being recreated.
 */
export const HOST_PROXY_CONTAINER_DIRECTORY_NAME = "container";
export const HOST_PROXY_SOCKET_NAME = "sock";
export const HOST_PROXY_CREDENTIALS_NAME = "credentials";
/**
 * Random identity of one container-facing directory, written once when the directory is created
 * and never rewritten while it exists. A container binds the directory itself, so a directory
 * recreated at the same path is a different bind source; the generation puts that in the
 * container contract. It is not secret.
 */
export const HOST_PROXY_GENERATION_NAME = ".generation";
const RUN_DIRECTORY_MODE = 0o700;
/** Traversable but not listable, so a container user of any uid reaches the files it is given. */
const CONTAINER_DIRECTORY_MODE = 0o711;
const GENERATION_MODE = 0o444;
const GENERATION_PATTERN = /^[0-9a-f]{32}$/u;

export const hostProxyContainerDirectory = (runDir: string): string =>
  join(runDir, HOST_PROXY_CONTAINER_DIRECTORY_NAME);

const verifyOwnedDirectory = async (directory: string, mode: number): Promise<void> => {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new PrivateFileAccessError(directory);
  if (
    process.platform !== "win32" &&
    ((metadata.mode & 0o777) !== mode || metadata.uid !== process.getuid?.())
  ) {
    throw new PrivateFileAccessError(directory);
  }
};

export const verifyHostProxyRunDirectory = (directory: string): Promise<void> =>
  verifyOwnedDirectory(directory, RUN_DIRECTORY_MODE);

/** The container-facing directory must be ours, real, and inside a private run directory. */
export const verifyHostProxyContainerDirectory = async (directory: string): Promise<void> => {
  await verifyHostProxyRunDirectory(dirname(directory));
  await verifyOwnedDirectory(directory, CONTAINER_DIRECTORY_MODE);
};

/** The directory's generation, or `undefined` when it has none yet; anything else is untrusted. */
const readGeneration = async (directory: string): Promise<string | undefined> => {
  const path = join(directory, HOST_PROXY_GENERATION_NAME);
  const metadata = await lstat(path).catch((cause: unknown) => {
    if (errnoCode(cause) === "ENOENT") return undefined;
    throw cause;
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isFile() || (process.platform !== "win32" && metadata.uid !== process.getuid?.()))
    throw new PrivateFileAccessError(path);
  const generation = await readFile(path, "utf8");
  if (!GENERATION_PATTERN.test(generation)) throw new PrivateFileAccessError(path);
  return generation;
};

/** Publishes a generation only when the directory has none, so concurrent callers agree on one. */
const ensureGeneration = async (directory: string): Promise<string> => {
  const existing = await readGeneration(directory);
  if (existing !== undefined) return existing;
  const staged = join(directory, `${HOST_PROXY_GENERATION_NAME}.${randomBytes(8).toString("hex")}`);
  try {
    await writeFile(staged, randomBytes(16).toString("hex"), { mode: GENERATION_MODE, flag: "wx" });
    await chmod(staged, GENERATION_MODE);
    // link refuses an existing target: the first complete generation wins and is never replaced.
    await link(staged, join(directory, HOST_PROXY_GENERATION_NAME)).catch((cause: unknown) => {
      if (errnoCode(cause) !== "EEXIST") throw cause;
    });
  } finally {
    await rm(staged, { force: true });
  }
  const published = await readGeneration(directory);
  if (published === undefined) throw new PrivateFileAccessError(join(directory, HOST_PROXY_GENERATION_NAME));
  return published;
};

const ensureContainerDirectory = async (
  runDir: string,
): Promise<{ readonly directory: string; readonly generation: string }> => {
  await mkdir(runDir, { recursive: true, mode: RUN_DIRECTORY_MODE });
  await verifyHostProxyRunDirectory(runDir);
  const directory = hostProxyContainerDirectory(runDir);
  await mkdir(directory, { mode: CONTAINER_DIRECTORY_MODE }).catch((cause: unknown) => {
    if (errnoCode(cause) !== "EEXIST") throw cause;
  });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new PrivateFileAccessError(directory);
  // mkdir applies the umask; the mode is part of the contract with non-root container users.
  if (process.platform !== "win32") await chmod(directory, CONTAINER_DIRECTORY_MODE);
  await verifyOwnedDirectory(directory, CONTAINER_DIRECTORY_MODE);
  return { directory, generation: await ensureGeneration(directory) };
};

/**
 * Creates the private run directory and its container-facing directory, keeping an existing
 * container-facing directory and its generation: containers bind that directory itself, so
 * replacing it would hide every later session from the containers already running.
 */
export const ensureHostProxyContainerDirectory = async (runDir: string): Promise<string> =>
  (await ensureContainerDirectory(runDir)).directory;

/** Generation of the run directory's container-facing directory, published once if it has none. */
export const hostProxyContainerGeneration = async (runDir: string): Promise<string> =>
  (await ensureContainerDirectory(runDir)).generation;

const removeEntries = async (directory: string, keep?: string): Promise<void> => {
  const entries = await readdir(directory).catch((cause: unknown) => {
    if (errnoCode(cause) === "ENOENT") return [];
    throw cause;
  });
  for (const entry of entries) {
    if (entry !== keep) await rm(join(directory, entry), { recursive: true, force: true });
  }
};

/**
 * Clears a run directory whose worker is gone without retiring the app's host-proxy: every
 * session file goes, but the container-facing directory itself and its generation stay so
 * containers that bind it see the next session. A run directory that is no longer private, or
 * whose container-facing directory or generation is not ours, is removed whole; the next session
 * recreates it privately under a new generation, which changes the container contract.
 */
export const resetHostProxyRunDirectory = async (runDir: string): Promise<void> => {
  const directory = hostProxyContainerDirectory(runDir);
  const trusted = await verifyHostProxyContainerDirectory(directory)
    .then(() => readGeneration(directory))
    .then(
      () => true,
      () => false,
    );
  if (!trusted) {
    await rm(runDir, { recursive: true, force: true });
    return;
  }
  await removeEntries(runDir, HOST_PROXY_CONTAINER_DIRECTORY_NAME);
  await removeEntries(directory, HOST_PROXY_GENERATION_NAME);
};
