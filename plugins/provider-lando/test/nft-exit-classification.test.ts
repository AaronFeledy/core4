import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressXz } from "../src/nft-provision.ts";

// These PATH-selected executable shell fixtures require POSIX shebang execution.
test.skipIf(process.platform === "win32")(
  "preserves Python cap exit with undrained full stdin and no xz",
  async () => {
    // Given: Python exits with its cap status without reading an input larger than the pipe.
    const root = await mkdtemp(join(tmpdir(), "lando-nft-exit-"));
    const previousPath = process.env.PATH;
    const pidFile = join(root, "pid");
    try {
      await writeFile(join(root, "python3"), `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexit 3\n`, {
        mode: 0o755,
      });
      process.env.PATH = root;
      // When: the production decoder writes eight MiB to that short-lived child.
      const result = await decompressXz(Buffer.alloc(8 * 1024 * 1024), {
        maxDecompressedBytes: 1024,
        timeoutMs: 2000,
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      // Then: exit 3 remains a cap error, rather than an EPIPE-triggered missing-xz fallback.
      expect(result).toBeInstanceOf(Error);
      if (!(result instanceof Error)) throw new Error("Expected decompression failure");
      expect(result.constructor.name).toBe("NftDecompressionCapError");
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
