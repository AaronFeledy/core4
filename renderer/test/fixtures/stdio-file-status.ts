import { dlopen } from "bun:ffi";
import { preserveStdioFileStatusFlags, restoreStdioFileStatusFlags } from "@lando/renderer/stdio-flags";

const scenario = process.argv[2] ?? "natural";
const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const bit = process.platform === "darwin" ? 0x4 : 0o4000;
// Same variadic-safe nine-argument shape as the code under test; reads use a plain 3-arg F_GETFL.
const setNonblock = (enabled: boolean): void => {
  const libc = dlopen(libcPath, {
    fcntl: { args: ["i32", "i32", "i64", "i64", "i64", "i64", "i64", "i64", "i64"], returns: "i32" },
  });
  const oracle = dlopen(libcPath, { fcntl: { args: ["i32", "i32", "i32"], returns: "i32" } });
  const current = oracle.symbols.fcntl(1, 3, 0);
  const value = BigInt(enabled ? current | bit : current & ~bit);
  libc.symbols.fcntl(1, 4, value, value, value, value, value, value, value);
  if (((oracle.symbols.fcntl(1, 3, 0) & bit) !== 0) !== enabled) {
    throw new Error(`Fixture failed to ${enabled ? "set" : "clear"} O_NONBLOCK`);
  }
  oracle.close();
  libc.close();
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
