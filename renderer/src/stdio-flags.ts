import { fstatSync } from "node:fs";
import { fileStatusFlags } from "@lando/engine/runtime/libc";

interface StdioSnapshot {
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly flags: number;
}
let stdioFlagsInstalled = false;
let reconcileStdioFlags: (() => void) | undefined;

export const restoreStdioFileStatusFlags = (): void => {
  reconcileStdioFlags?.();
};

export const preserveStdioFileStatusFlags = (): void => {
  if (stdioFlagsInstalled) return;
  stdioFlagsInstalled = true;
  const flags = fileStatusFlags();
  if (flags === undefined) return;
  const { nonblock } = flags;
  const snapshots: StdioSnapshot[] = [];
  for (const fd of [0, 1, 2]) {
    try {
      const { dev, ino } = fstatSync(fd, { bigint: true });
      const current = flags.get(fd);
      if (current >= 0) snapshots.push({ fd, dev, ino, flags: current });
    } catch {
      // Closed or unavailable inherited descriptors need no restoration.
    }
  }
  reconcileStdioFlags = () => {
    for (const snapshot of snapshots) {
      try {
        const { dev, ino } = fstatSync(snapshot.fd, { bigint: true });
        if (dev !== snapshot.dev || ino !== snapshot.ino) continue;
        const current = flags.get(snapshot.fd);
        if (current >= 0 && (current & nonblock) !== (snapshot.flags & nonblock)) {
          flags.set(snapshot.fd, (current & ~nonblock) | (snapshot.flags & nonblock));
        }
      } catch {
        // Exit cleanup is best-effort when a descriptor has been closed or replaced.
      }
    }
  };
  process.once("exit", restoreStdioFileStatusFlags);
};
