import { type Context, Effect, Layer, Stream } from "effect";

import { FileIoError, FileNotFoundError, FilePermissionError } from "@lando/sdk/errors";
import { type FileStat, FileSystem, type FileSystemError } from "@lando/sdk/services";

const permissionCodes = new Set(["EACCES", "EPERM"]);

const codeFrom = (cause: unknown): string | undefined => {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

const messageFrom = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

const fileError = (path: string, cause: unknown, fallback: string): FileSystemError => {
  const code = codeFrom(cause);
  if (code === "ENOENT") {
    return new FileNotFoundError({ message: messageFrom(cause, fallback), path, cause });
  }
  if (code !== undefined && permissionCodes.has(code)) {
    return new FilePermissionError({ message: messageFrom(cause, fallback), path, cause });
  }
  return new FileIoError({ message: messageFrom(cause, fallback), path, cause });
};

const notFound = (path: string): FileNotFoundError =>
  new FileNotFoundError({ message: `File not found: ${path}`, path });

const isFileSystemError = (cause: unknown): cause is FileSystemError =>
  cause instanceof FileNotFoundError || cause instanceof FilePermissionError || cause instanceof FileIoError;

const mapFileError =
  (path: string, fallback: string) =>
  (cause: unknown): FileSystemError =>
    isFileSystemError(cause) ? cause : fileError(path, cause, fallback);

const joinPath = (base: string, child: string): string =>
  base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;

async function* readChunks(path: string): AsyncGenerator<Uint8Array> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw notFound(path);
  }

  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

const readText = async (path: string): Promise<string> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw notFound(path);
  }
  return await file.text();
};

const write = async (path: string, content: string | Uint8Array): Promise<void> => {
  await Bun.write(path, content);
};

const writeAtomic = async (path: string, content: string | Uint8Array): Promise<void> => {
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Bun.write(tempPath, content);
    await Bun.write(path, Bun.file(tempPath));
  } finally {
    if (await Bun.file(tempPath).exists()) {
      await Bun.file(tempPath).delete();
    }
  }
};

const stat = async (path: string): Promise<FileStat> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw notFound(path);
  }
  const stats = await file.stat();
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
  };
};

const mkdir = async (path: string): Promise<void> => {
  const marker = joinPath(path, `.lando-mkdir-${crypto.randomUUID()}`);
  await Bun.write(marker, "");
  await Bun.file(marker).delete();
};

const readDir = async (path: string): Promise<ReadonlyArray<string>> => {
  const entries: string[] = [];
  for await (const entry of new Bun.Glob("*").scan({ cwd: path, onlyFiles: false, dot: true })) {
    entries.push(entry);
  }
  return entries.sort();
};

const remove = async (path: string): Promise<void> => {
  const file = Bun.file(path);
  if (await file.exists()) {
    await file.delete();
    return;
  }

  // path may not exist at all — Bun.Glob.scan throws ENOENT for a non-existent cwd,
  // so catch that case and return silently (no-op semantics for missing paths).
  try {
    for await (const entry of new Bun.Glob("**/*").scan({ cwd: path, onlyFiles: true, dot: true })) {
      await Bun.file(joinPath(path, entry)).delete();
    }
  } catch (err) {
    if (codeFrom(err) === "ENOENT") return;
    throw err;
  }
};

const fileSystemService: Context.Tag.Service<typeof FileSystem> = {
  read: (path) => Stream.fromAsyncIterable(readChunks(path), mapFileError(path, `Failed to read ${path}`)),
  readText: (path) =>
    Effect.tryPromise({
      try: () => readText(path),
      catch: mapFileError(path, `Failed to read ${path}`),
    }),
  write: (path, content) =>
    Effect.tryPromise({
      try: () => write(path, content),
      catch: mapFileError(path, `Failed to write ${path}`),
    }),
  writeAtomic: (path, content) =>
    Effect.tryPromise({
      try: () => writeAtomic(path, content),
      catch: mapFileError(path, `Failed to write ${path}`),
    }),
  exists: (path) =>
    Effect.tryPromise({
      try: () => Bun.file(path).exists(),
      catch: mapFileError(path, `Failed to check ${path}`),
    }),
  stat: (path) =>
    Effect.tryPromise({
      try: () => stat(path),
      catch: mapFileError(path, `Failed to stat ${path}`),
    }),
  mkdir: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path),
      catch: mapFileError(path, `Failed to create ${path}`),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => remove(path),
      catch: mapFileError(path, `Failed to remove ${path}`),
    }),
  readDir: (path) =>
    Effect.tryPromise({
      try: () => readDir(path),
      catch: mapFileError(path, `Failed to list ${path}`),
    }),
  readFile: (path) => fileSystemService.readText(path),
  writeFile: (path, content) => fileSystemService.write(path, content),
};

export const FileSystemLive = Layer.succeed(FileSystem, fileSystemService);
