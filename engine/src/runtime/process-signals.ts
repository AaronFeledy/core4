import { readFileSync } from "node:fs";
import { darwinIgnoresHangup, darwinIgnoresInterrupt } from "./libc.ts";

// SIG_IGN survives exec. Installing a listener would undo the shell's policy.
export const defaultInterruptSignals = (): ReadonlyArray<NodeJS.Signals> => {
  let ignoreInterrupt = false;
  let ignoreHangup = process.platform === "win32";
  if (process.platform === "linux") {
    try {
      const mask = /^SigIgn:\s*([0-9a-fA-F]+)$/mu.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
      ignoreInterrupt = mask !== undefined && (BigInt(`0x${mask}`) & 2n) !== 0n;
      ignoreHangup = mask !== undefined && (BigInt(`0x${mask}`) & 1n) !== 0n;
    } catch {
      // Hosts without procfs retain the existing interrupt behavior.
    }
  }
  if (process.platform === "darwin") {
    ignoreInterrupt = darwinIgnoresInterrupt();
    ignoreHangup = darwinIgnoresHangup();
  }
  return [
    ...(ignoreInterrupt ? [] : ["SIGINT" as const]),
    "SIGTERM",
    ...(ignoreHangup ? [] : ["SIGHUP" as const]),
  ];
};
