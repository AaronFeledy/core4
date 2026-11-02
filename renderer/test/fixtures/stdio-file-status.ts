import { dlopen } from "bun:ffi";
import { fileStatusFlags } from "@lando/engine/runtime/libc";
import { preserveStdioFileStatusFlags, restoreStdioFileStatusFlags } from "@lando/renderer/stdio-flags";

const scenario = process.argv[2] ?? "natural";
const oracle = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
});
// Change fd 1 through the shared binding, then confirm with an independent 3-arg F_GETFL.
const setNonblock = (enabled: boolean): void => {
  const flags = fileStatusFlags();
  if (flags === undefined) throw new Error("Expected native file-status bindings");
  const current = flags.get(1);
  flags.set(1, enabled ? current | flags.nonblock : current & ~flags.nonblock);
  if (((oracle.symbols.fcntl(1, 3, 0) & flags.nonblock) !== 0) !== enabled) {
    throw new Error(`Fixture failed to ${enabled ? "set" : "clear"} O_NONBLOCK`);
  }
};
if (scenario === "initially-nonblocking") setNonblock(true);
if (scenario !== "control") preserveStdioFileStatusFlags();
process.stdout.write("stdout\n");
process.stderr.write("stderr\n");
if (scenario === "explicit-exit") process.exit(3);
// Something else (e.g. Bun spawning an inherited-stdio child) clears the bit; exit must set it back.
if (scenario === "initially-nonblocking") setNonblock(false);
if (scenario === "reconcile") {
  restoreStdioFileStatusFlags();
  // A second install must not replace the startup snapshot after output dirties it.
  const writer = Bun.stdout.writer();
  writer.write("x");
  await writer.flush();
  preserveStdioFileStatusFlags();
}
