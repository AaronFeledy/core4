import { basename, extname } from "node:path";
import { stdin } from "node:process";
import { Schema } from "effect";

export const HOST_PROXY_WORKER_COMMAND = "__internal:host-proxy-worker";

export const WorkerReady = Schema.TaggedStruct("ready", {
  appId: Schema.String,
  sessionId: Schema.String,
  token: Schema.String,
  socketPath: Schema.String,
  shimPath: Schema.String,
});
export type WorkerReady = typeof WorkerReady.Type;

export interface HostProxyWorkerProcess {
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
  readonly writeStdin: (value: string) => Promise<void>;
  readonly readReady: () => Promise<WorkerReady>;
  readonly terminate: () => Promise<void>;
}

export interface HostProxyWorkerSpawnSpec {
  readonly argv: ReadonlyArray<string>;
}

export type HostProxyWorkerSpawner = (spec: HostProxyWorkerSpawnSpec) => HostProxyWorkerProcess;

export const hostProxyWorkerArgv = (
  input: { readonly entryPath?: string | undefined } = {},
): ReadonlyArray<string> => {
  const entryPath = input.entryPath ?? process.argv[1];
  if (entryPath !== undefined && extname(entryPath) === ".ts" && entryPath.endsWith("bin/lando.ts"))
    return [process.execPath, entryPath, HOST_PROXY_WORKER_COMMAND];
  if (basename(process.execPath).startsWith("bun")) {
    return [
      process.execPath,
      new URL("../../../bin/lando.ts", import.meta.url).pathname,
      HOST_PROXY_WORKER_COMMAND,
    ];
  }
  return [process.execPath, HOST_PROXY_WORKER_COMMAND];
};

const textFromStreamUntilLine = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  return text;
};

const textFromStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
};

export const defaultSpawnWorker: HostProxyWorkerSpawner = (spec) => {
  const proc = Bun.spawn([...spec.argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  proc.unref?.();
  return {
    pid: proc.pid,
    argv: spec.argv,
    writeStdin: async (value) => {
      proc.stdin.write(value);
      proc.stdin.end();
    },
    readReady: async () => {
      const line = await textFromStreamUntilLine(proc.stdout);
      if (line.length > 0) return Schema.decodeUnknownSync(WorkerReady)(JSON.parse(line));
      await proc.exited;
      const stderr = (await textFromStream(proc.stderr)).trim();
      throw new Error(stderr.length === 0 ? "Detached host-proxy worker exited before readiness." : stderr);
    },
    terminate: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
};

export const stdinText = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin)
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};
