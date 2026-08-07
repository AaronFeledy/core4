/**
 * `FileSystem` service — `Bun.file` / `Bun.write` wrapper.
 *
 * `Bun.file` and `Bun.write` are the filesystem primitives. `node:fs` is
 * allowed only inside the `FileSystem` adapter implementation when Bun
 * lacks a primitive (e.g., `fs.watch` parity).
 *
 * Replaceable for sandboxing or remote-FS use cases.
 *
 * Status: stub.
 */
export { FileSystem } from "@lando/sdk/services";
