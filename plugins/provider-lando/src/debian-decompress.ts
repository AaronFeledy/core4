import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { isErrnoCode } from "@lando/sdk/errors";
import { DebianArchiveError } from "./debian-archive.ts";

export interface NftDecompressionOptions {
  readonly maxDecompressedBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class DecompressionLimitError extends DebianArchiveError {}
class DecompressionTimeoutError extends DebianArchiveError {}
class DecompressionCancelledError extends DebianArchiveError {}

const collectOutput = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  failOnLimit: boolean,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const remaining = maxBytes - length;
    if (chunk.byteLength > remaining && failOnLimit) {
      throw new DecompressionLimitError(
        `The Debian package exceeded the decompressed-size cap of ${maxBytes} bytes.`,
      );
    }
    const bounded = chunk.subarray(0, Math.max(0, remaining));
    chunks.push(bounded);
    length += bounded.byteLength;
  }
  return Buffer.concat(chunks, length);
};

interface DecompressionProcess {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
  readonly maxDecompressedBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

const runBounded = async (input: DecompressionProcess) => {
  if (input.signal?.aborted === true)
    throw new DecompressionCancelledError("Debian package decompression was cancelled.");
  const proc = Bun.spawn([input.command, ...input.args], {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = collectOutput(proc.stdout, input.maxDecompressedBytes, true);
  const stderr = collectOutput(proc.stderr, 64 * 1024, false);
  const write = (async () => {
    try {
      await proc.stdin.write(input.stdin);
      await proc.stdin.flush();
      await proc.stdin.end();
    } catch (cause) {
      // Killing an over-limit decoder can close stdin before its buffered write finishes.
      if (isErrnoCode(cause, "EPIPE") && (await proc.exited) !== 0) return;
      throw cause;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DecompressionTimeoutError(`Debian package decompression timed out after ${input.timeoutMs}ms.`),
        ),
      input.timeoutMs,
    );
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(new DecompressionCancelledError("Debian package decompression was cancelled."));
    input.signal?.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const [bytes, errors, exitCode] = await Promise.race([
      Promise.all([stdout, stderr, proc.exited, write]),
      timeout,
      cancelled,
    ]);
    return { exitCode, stdout: bytes, stderr: new TextDecoder().decode(errors) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) input.signal?.removeEventListener("abort", abortListener);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await Promise.allSettled([stdout, stderr, write]);
  }
};

const resolveOptions = (options?: NftDecompressionOptions) => ({
  maxDecompressedBytes: options?.maxDecompressedBytes ?? 64 * 1024 ** 2,
  timeoutMs: options?.timeoutMs ?? 30_000,
  ...(options?.signal === undefined ? {} : { signal: options.signal }),
});

export const decompressXz = async (
  bytes: Uint8Array,
  options?: NftDecompressionOptions,
): Promise<Uint8Array> => {
  const resolved = resolveOptions(options);
  try {
    const python = await runBounded({
      command: "python3",
      args: [
        "-c",
        `import lzma,sys
remaining = int(sys.argv[1])
with lzma.LZMAFile(sys.stdin.buffer) as source:
    while True:
        chunk = source.read(min(65536, remaining + 1))
        if len(chunk) > remaining:
            sys.exit(3)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        remaining -= len(chunk)`,
        String(resolved.maxDecompressedBytes),
      ],
      stdin: bytes,
      ...resolved,
    });
    if (python.exitCode === 3)
      throw new DecompressionLimitError(
        `The Debian package exceeded the decompressed-size cap of ${resolved.maxDecompressedBytes} bytes.`,
      );
    if (python.exitCode === 0 && python.stdout.length > 0) return python.stdout;
  } catch (cause) {
    if (cause instanceof DebianArchiveError) throw cause;
    if (!isErrnoCode(cause, "ENOENT")) throw cause;
  }
  const xz = await runBounded({ command: "xz", args: ["-dc"], stdin: bytes, ...resolved });
  if (xz.exitCode !== 0) throw new DebianArchiveError(xz.stderr.trim() || "Failed to decompress xz payload.");
  return xz.stdout;
};

export const decompressDebDataTar = async (
  memberName: string,
  bytes: Uint8Array,
  options?: NftDecompressionOptions,
): Promise<Uint8Array> => {
  const resolved = resolveOptions(options);
  if (resolved.signal?.aborted === true)
    throw new DecompressionCancelledError("Debian package decompression was cancelled.");
  if (memberName.endsWith(".tar.xz")) return decompressXz(bytes, resolved);
  if (memberName.endsWith(".tar")) {
    if (bytes.length > resolved.maxDecompressedBytes)
      throw new DecompressionLimitError("Debian tar exceeds decompressed-size cap.");
    return bytes;
  }
  try {
    if (memberName.endsWith(".tar.gz") || memberName.endsWith(".tgz")) {
      return new Uint8Array(
        gunzipSync(Buffer.from(bytes), { maxOutputLength: resolved.maxDecompressedBytes }),
      );
    }
    if (memberName.endsWith(".tar.zst") || memberName.endsWith(".tar.zstd")) {
      return new Uint8Array(
        zstdDecompressSync(Buffer.from(bytes), { maxOutputLength: resolved.maxDecompressedBytes }),
      );
    }
  } catch (cause) {
    if (isErrnoCode(cause, "ERR_BUFFER_TOO_LARGE"))
      throw new DecompressionLimitError(
        `The Debian package exceeded the decompressed-size cap of ${resolved.maxDecompressedBytes} bytes.`,
      );
    throw cause;
  }
  throw new DebianArchiveError(`Unsupported deb data archive "${memberName}".`);
};
