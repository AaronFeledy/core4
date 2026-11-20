import {
  type Stats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { platform } from "node:os";
import { toNamespacedPath } from "node:path";
import { isErrnoCode } from "@lando/sdk/errors";

type Ffi = typeof import("bun:ffi");
type Mode = "exclusive" | "shared";
type Attempt = "acquired" | "contended" | "interrupted";

export interface NativeLockHandle {
  readonly created: boolean;
  readonly tryLock: (mode: Mode) => Attempt;
  readonly withRecord: <A>(use: (fd: number) => A) => A;
  readonly verifyIdentity: () => boolean;
  readonly unlinkIfCurrent?: () => void;
  readonly unlock: () => void;
  readonly close: () => void;
}

export class UnsafeSentinelError extends Error {}

export const checkSentinel = (stat: ReturnType<typeof lstatSync>) => {
  if (stat === undefined) throw new UnsafeSentinelError("the file disappeared");
  if (stat.isSymbolicLink()) throw new UnsafeSentinelError("a symbolic link");
  if (!stat.isFile()) throw new UnsafeSentinelError("not a regular file");
  if (stat.nlink !== 1) throw new UnsafeSentinelError("hard-linked to another file");
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new UnsafeSentinelError("owned by another user");
};

const posix = ({ dlopen, read }: Ffi, darwin: boolean) => {
  const flockSignature = { args: ["i32", "i32"], returns: "i32" } as const;
  const errnoSignature = { args: [], returns: "ptr" } as const;
  const { flock, errnoLocation } = darwin
    ? (() => {
        const { symbols } = dlopen("libSystem.B.dylib", { flock: flockSignature, __error: errnoSignature });
        return { flock: symbols.flock, errnoLocation: symbols.__error };
      })()
    : (() => {
        const { symbols } = dlopen("libc.so.6", { flock: flockSignature, __errno_location: errnoSignature });
        return { flock: symbols.flock, errnoLocation: symbols.__errno_location };
      })();
  const errno = () => {
    const location = errnoLocation();
    if (location === null) throw new Error("Unable to read flock errno");
    return read.i32(location, 0);
  };
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return (path: string): NativeLockHandle => {
    let created = true;
    let fd: number;
    try {
      fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (cause) {
      if (!isErrnoCode(cause, "EEXIST")) throw cause;
      created = false;
      fd = openSync(path, flags);
    }
    const checkPrivate = (stat: Stats) => {
      checkSentinel(stat);
      if ((stat.mode & 0o077) !== 0) throw new UnsafeSentinelError("accessible to other users");
    };
    try {
      const opened = fstatSync(fd);
      if (opened.nlink !== 0) checkPrivate(opened);
      if (created) fchmodSync(fd, 0o600);
    } catch (cause) {
      closeSync(fd);
      throw cause;
    }
    return {
      created,
      verifyIdentity: () => {
        const held = fstatSync(fd);
        const named = lstatSync(path, { throwIfNoEntry: false });
        if (named === undefined) return false;
        checkPrivate(named);
        if (held.nlink === 0) return false;
        checkPrivate(held);
        return held.dev === named.dev && held.ino === named.ino;
      },
      unlinkIfCurrent: () => {
        const held = fstatSync(fd);
        const named = lstatSync(path, { throwIfNoEntry: false });
        if (named === undefined || held.dev !== named.dev || held.ino !== named.ino) return;
        try {
          unlinkSync(path);
        } catch (cause) {
          if (!isErrnoCode(cause, "ENOENT")) throw cause;
        }
      },
      withRecord: (use) => use(fd),
      tryLock: (mode) => {
        if (flock(fd, (mode === "shared" ? 1 : 2) | 4) === 0) return "acquired";
        const error = errno();
        if (error === (darwin ? 35 : 11)) return "contended";
        if (error === 4) return "interrupted";
        throw new Error(`flock failed (errno ${error})`);
      },
      unlock: () => {
        if (flock(fd, 8) !== 0) throw new Error(`flock unlock failed (errno ${errno()})`);
      },
      close: () => closeSync(fd),
    };
  };
};

const windows = ({ dlopen, ptr }: Ffi) => {
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("LockFileEx requires Win64");
  const { symbols } = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
    LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
    UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  return (path: string): NativeLockHandle => {
    // Windows keeps the sentinel persistent and denies FILE_SHARE_DELETE.
    // OPEN_ALWAYS, READ|WRITE sharing, synchronous, no reparse traversal,
    // and null security attributes for a non-inheritable handle.
    const name = Buffer.from(`${toNamespacedPath(path)}\0`, "utf16le");
    const handle = symbols.CreateFileW(ptr(name), 0xc0000000, 3, null, 4, 0x00200000, 0n);
    const status = symbols.GetLastError();
    if (handle === 0xffff_ffff_ffff_ffffn) throw new Error(`CreateFileW failed (Win32 ${status})`);
    const close = () => {
      if (symbols.CloseHandle(handle) === 0)
        throw new Error(`CloseHandle failed (Win32 ${symbols.GetLastError()})`);
    };
    try {
      const info = Buffer.alloc(52);
      if (symbols.GetFileInformationByHandle(handle, ptr(info)) === 0)
        throw new Error(`GetFileInformationByHandle failed (Win32 ${symbols.GetLastError()})`);
      if ((info.readUInt32LE(0) & 0x400) !== 0) throw new UnsafeSentinelError("a reparse point");
      if (info.readUInt32LE(40) !== 1) throw new UnsafeSentinelError("hard-linked to another file");
      checkSentinel(lstatSync(path));
    } catch (cause) {
      close();
      throw cause;
    }
    // Win64 OVERLAPPED, locking byte 2^32 only. Diagnostic I/O uses a separate
    // node:fs handle at offset zero and never touches the locked region.
    const overlapped = Buffer.alloc(32);
    overlapped.writeUInt32LE(1, 20);
    return {
      created: status !== 183, // ERROR_ALREADY_EXISTS
      verifyIdentity: () => {
        checkSentinel(lstatSync(path));
        return true;
      },
      withRecord: (use) => {
        const fd = openSync(path, constants.O_RDWR);
        try {
          return use(fd);
        } finally {
          closeSync(fd);
        }
      },
      tryLock: (mode) => {
        if (symbols.LockFileEx(handle, mode === "exclusive" ? 3 : 1, 0, 1, 0, ptr(overlapped)) !== 0)
          return "acquired";
        const error = symbols.GetLastError();
        if (error === 33) return "contended"; // ERROR_LOCK_VIOLATION
        throw new Error(`LockFileEx failed (Win32 ${error})`);
      },
      unlock: () => {
        if (symbols.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped)) === 0)
          throw new Error(`UnlockFileEx failed (Win32 ${symbols.GetLastError()})`);
      },
      close,
    };
  };
};

type OpenNativeLock = (path: string) => NativeLockHandle;
let bindings: Promise<OpenNativeLock> | undefined;
const loadNativeLock = async (): Promise<OpenNativeLock> => {
  const ffi = await import("bun:ffi");
  switch (platform()) {
    case "linux":
      return posix(ffi, false);
    case "darwin":
      return posix(ffi, true);
    case "win32":
      return windows(ffi);
    default:
      throw new Error(`No native advisory locking support on ${platform()}`);
  }
};

export const nativeLock = (): Promise<OpenNativeLock> => (bindings ??= loadNativeLock());
