import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { REDACTED, type Redactor } from "@lando/sdk/secrets";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

export class DetachedWorkerLogError extends Error {
  constructor(
    readonly logPath: string,
    options?: ErrorOptions,
  ) {
    super(`Unable to open private detached worker log: ${logPath}`, options);
    this.name = "DetachedWorkerLogError";
  }
}

export const openWorkerLog = async (
  logsDir: string,
  logPath: string,
  privateFileAccess: PrivateFileAccess | undefined,
): Promise<number> => {
  let fd: number | undefined;
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const existing = lstatSync(logPath, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isFile()) throw new DetachedWorkerLogError(logPath);
    fd = openSync(
      logPath,
      constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new DetachedWorkerLogError(logPath);
    if (stat.size > 1024 * 1024) ftruncateSync(fd, 0);
    if (process.platform === "win32") {
      if (privateFileAccess === undefined) throw new DetachedWorkerLogError(logPath);
      await privateFileAccess.enforce(logPath);
      await privateFileAccess.verify(logPath);
      const current = lstatSync(logPath);
      if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev)
        throw new DetachedWorkerLogError(logPath);
    } else {
      if (stat.uid !== process.getuid?.()) throw new DetachedWorkerLogError(logPath);
      fchmodSync(fd, 0o600);
    }
    return fd;
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    throw cause instanceof DetachedWorkerLogError ? cause : new DetachedWorkerLogError(logPath, { cause });
  }
};

const TAIL_BYTES = 4 * 1024;
const READ_BYTES = TAIL_BYTES + 64 * 1024;

export const stderrTailFromLog = async (logPath: string, redactor: Redactor): Promise<string> => {
  const file = Bun.file(logPath);
  if (!(await file.exists())) return "";
  // Redactor does not expose the longest registered secret. A partial read
  // cannot safely redact multiline values, so suppress oversized logs entirely.
  if (file.size > READ_BYTES) return REDACTED;
  const redacted = Buffer.from(redactor.redactString(await file.slice(0, READ_BYTES).text()));
  let text = redacted.subarray(-TAIL_BYTES).toString("utf8");
  if (redacted.length > TAIL_BYTES) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? REDACTED : text.slice(newline + 1);
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-8)
    .join("\n");
};

export const writeWorkerDiagnostic = (entry: {
  readonly callId: string;
  readonly operation: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly exitCode?: number;
}): void => {
  const metadata = fstatSync(2);
  if (!metadata.isFile()) return;
  if (metadata.size > 1024 * 1024) ftruncateSync(2, 0);
  writeSync(
    2,
    `${JSON.stringify({
      callId: entry.callId.slice(0, 80),
      operation: entry.operation.slice(0, 16),
      outcome: entry.outcome.slice(0, 80),
      durationMs: entry.durationMs,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    })}\n`,
  );
};
