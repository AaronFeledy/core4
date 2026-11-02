/** Changes here run the full CI platform matrix: calling conventions differ per platform. */
interface FileStatusFlags {
  readonly get: (fd: number) => number;
  readonly set: (fd: number, flags: number) => number;
  readonly nonblock: number;
}

interface Libc {
  readonly flags: FileStatusFlags;
  readonly ignoresInterrupt: () => boolean;
}

const F_GETFL = 3;
const F_SETFL = 4;

let loaded = false;
let libc: Libc | undefined;

const loadLibc = (): Libc | undefined => {
  if (loaded) return libc;
  loaded = true;
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  try {
    const ffi: typeof import("bun:ffi") = require("bun:ffi");
    // Keep libc open: process exit listeners still need its symbols.
    const fcntlBinding = {
      args: ["i32", "i32", "i64", "i64", "i64", "i64", "i64", "i64", "i64"],
      returns: "i32",
    } as const;
    const bindings =
      process.platform === "darwin"
        ? ({ fcntl: fcntlBinding, sigaction: { args: ["i32", "ptr", "ptr"], returns: "i32" } } as const)
        : { fcntl: fcntlBinding };
    const library = ffi.dlopen(
      process.platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib",
      bindings,
    );
    // SysV x86-64 / Linux AAPCS64 use arg 3 for variadic ints; Apple arm64
    // uses the stack, whose first slot is arg 9 after x0–x7. Fill both locations.
    const fcntl = (fd: number, cmd: number, value = 0n): number =>
      library.symbols.fcntl(fd, cmd, value, value, value, value, value, value, value);
    libc = {
      flags: {
        get: (fd) => fcntl(fd, F_GETFL),
        set: (fd, flags) => fcntl(fd, F_SETFL, BigInt(flags)),
        nonblock: process.platform === "linux" ? 0o4000 : 0x4,
      },
      ignoresInterrupt: () => {
        // Query sigaction without changing disposition. Darwin's handler is the first pointer.
        const action = new BigUint64Array(2);
        const sigaction = library.symbols.sigaction;
        return sigaction !== undefined && sigaction(2, null, ffi.ptr(action)) === 0 && action[0] === 1n;
      },
    };
  } catch {
    // Native process facts are best-effort on hosts without these libc bindings (e.g. musl).
  }
  return libc;
};

export const fileStatusFlags = (): FileStatusFlags | undefined => loadLibc()?.flags;

export const darwinIgnoresInterrupt = (): boolean =>
  process.platform === "darwin" && (loadLibc()?.ignoresInterrupt() ?? false);
