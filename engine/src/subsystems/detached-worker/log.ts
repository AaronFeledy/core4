import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";
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
// Redact the complete log before clipping so even a secret longer than the tail cannot leak a suffix.

export const stderrTailFromLog = async (
  logPath: string,
  redactor: Redactor = createStandaloneRedactor("secrets"),
): Promise<string> => {
  const file = Bun.file(logPath);
  if (!(await file.exists())) return "";
  const text = await file.text();
  return redactor
    .redactString(text)
    .slice(-TAIL_BYTES)
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-8)
    .join("\n");
};
