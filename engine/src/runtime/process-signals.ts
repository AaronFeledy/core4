import { readFileSync } from "node:fs";

const darwinIgnoresInterrupt = (): boolean => {
  // Query sigaction without changing disposition. Darwin's handler is the first pointer.
  const { dlopen, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sigaction: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  });
  try {
    const action = new BigUint64Array(2);
    return libc.symbols.sigaction(2, null, ptr(action)) === 0 && action[0] === 1n;
  } finally {
    libc.close();
  }
};

// SIG_IGN survives exec. Installing a listener would undo the shell's policy.
export const defaultInterruptSignals = (): ReadonlyArray<NodeJS.Signals> => {
  let ignoreInterrupt = false;
  if (process.platform === "linux") {
    try {
      const mask = /^SigIgn:\s*([0-9a-fA-F]+)$/mu.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
      ignoreInterrupt = mask !== undefined && (BigInt(`0x${mask}`) & 2n) !== 0n;
    } catch {
      // Hosts without procfs retain the existing interrupt behavior.
    }
  }
  if (process.platform === "darwin") ignoreInterrupt = darwinIgnoresInterrupt();
  // SIGHUP is deliberately absent: nohup's inherited disposition stays intact.
  return ignoreInterrupt ? ["SIGTERM"] : ["SIGINT", "SIGTERM"];
};
