import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const canUseFifo = process.platform !== "win32";

export const mkfifo = async (path: string): Promise<void> => {
  const proc = Bun.spawn(["mkfifo", "-m", "0600", path], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`mkfifo failed (${code}): ${await new Response(proc.stderr).text()}`);
  }
};

export const captureFifo = (fifo: string, dest: string): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(["cat", fifo], { stdout: Bun.file(dest), stderr: "ignore" });

export const feedFifo = (source: string, fifo: string): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(["sh", "-c", 'cat "$1" > "$2"', "_", source, fifo], { stderr: "ignore" });

export const stopProc = async (proc: ReturnType<typeof Bun.spawn>): Promise<void> => {
  proc.kill();
  await proc.exited.catch(() => undefined);
};

export const withFifoDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-sql-fifo-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const writeFifoPayload = async (
  dir: string,
  name: string,
  payload: Uint8Array | string,
): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, payload);
  return path;
};

export const withTimeout = <A>(promise: Promise<A>, ms: number, label: string): Promise<A> =>
  Promise.race([
    promise,
    new Promise<A>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);
