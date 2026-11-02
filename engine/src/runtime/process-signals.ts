import { readFileSync } from "node:fs";
import { darwinIgnoresInterrupt } from "./libc.ts";

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
