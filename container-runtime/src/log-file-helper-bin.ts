import { type FileHandle, open, rm, stat as statPath } from "node:fs/promises";
import { argv, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const maxReadBytes = 65_536;
const maxSafeOffset = BigInt(Number.MAX_SAFE_INTEGER);
const helperDirectoryPattern = /^\/tmp\/lando-log-file-helper-[0-9a-f]{32}$/;
const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;

type Command =
  | { readonly op: "stat"; readonly path: string }
  | { readonly op: "open"; readonly path: string }
  | { readonly op: "fstat" }
  | { readonly op: "read"; readonly offset: string; readonly maxBytes: number }
  | { readonly op: "close" };

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "log helper operation failed";

const write = (value: unknown): void => {
  stdout.write(`${JSON.stringify(value)}\n`);
};

const fileStat = (stat: Awaited<ReturnType<FileHandle["stat"]>>) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
});

const isUnsignedDecimal = (value: string): boolean => unsignedDecimalPattern.test(value);

const isSafeReadLength = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const pathStat = async (path: string): Promise<void> => {
  try {
    write({ ok: true, stat: fileStat(await statPath(path)) });
  } catch (cause) {
    if (!(cause instanceof Error) && errorCode(cause) === undefined) throw cause;
    if (errorCode(cause) === "ENOENT") {
      write({ ok: true, missing: true });
      return;
    }
    write({ ok: false, code: errorCode(cause) ?? "EACCESS", message: errorMessage(cause) });
  }
};

const decodeCommand = (input: unknown): Command | undefined => {
  if (typeof input !== "object" || input === null || !("op" in input)) return undefined;
  if (input.op === "stat" || input.op === "open") {
    return "path" in input && typeof input.path === "string" ? { op: input.op, path: input.path } : undefined;
  }
  if (input.op === "fstat" || input.op === "close") return { op: input.op };
  if (input.op === "read") {
    return "offset" in input &&
      "maxBytes" in input &&
      typeof input.offset === "string" &&
      typeof input.maxBytes === "number" &&
      isUnsignedDecimal(input.offset) &&
      isSafeReadLength(input.maxBytes)
      ? { op: "read", offset: input.offset, maxBytes: input.maxBytes }
      : undefined;
  }
  return undefined;
};

let handle: FileHandle | undefined;

const closeHandle = async (): Promise<void> => {
  const current = handle;
  handle = undefined;
  if (current !== undefined) await current.close();
  write({ ok: true });
};

const cleanupHelper = async (path: string): Promise<void> => {
  if (!helperDirectoryPattern.test(path)) {
    write({ ok: false, code: "EPROTO", message: "invalid helper cleanup path" });
    return;
  }
  await rm(path, { recursive: true, force: true });
  write({ ok: true });
};

const run = async (command: Command): Promise<void> => {
  if (command.op === "stat") {
    await pathStat(command.path);
    return;
  }
  if (command.op === "open") {
    try {
      handle = await open(command.path, "r");
      write({ ok: true, stat: fileStat(await handle.stat()) });
    } catch (cause) {
      if (!(cause instanceof Error) && errorCode(cause) === undefined) throw cause;
      write({ ok: false, code: errorCode(cause) ?? "EACCESS", message: errorMessage(cause) });
    }
    return;
  }
  if (command.op === "close") {
    await closeHandle();
    return;
  }
  if (handle === undefined) {
    write({ ok: false, code: "EBADF", message: "log file is not open" });
    return;
  }
  if (command.op === "fstat") {
    write({ ok: true, stat: fileStat(await handle.stat()) });
    return;
  }
  const position = BigInt(command.offset);
  if (position > maxSafeOffset) {
    write({ ok: false, code: "ERANGE", message: "read offset is outside the safe positional-read range" });
    return;
  }
  const length = Math.max(0, Math.min(command.maxBytes, maxReadBytes));
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, Number(position));
  write({
    ok: true,
    bytes: buffer.subarray(0, result.bytesRead).toString("base64"),
    nextOffset: String(BigInt(command.offset) + BigInt(result.bytesRead)),
    eof: result.bytesRead < length,
  });
};

const cleanupArgIndex = argv.indexOf("cleanup");
if (cleanupArgIndex >= 0) {
  const path = argv[cleanupArgIndex + 1];
  await cleanupHelper(typeof path === "string" ? path : "");
} else {
  const lines = createInterface({ input: stdin });
  for await (const line of lines) {
    try {
      const command = decodeCommand(JSON.parse(line));
      if (command === undefined) write({ ok: false, code: "EPROTO", message: "invalid helper command" });
      else await run(command);
    } catch (cause) {
      if (!(cause instanceof Error) && errorCode(cause) === undefined) throw cause;
      write({ ok: false, code: errorCode(cause) ?? "EIO", message: errorMessage(cause) });
    }
  }
  if (handle !== undefined) await closeHandle();
}
