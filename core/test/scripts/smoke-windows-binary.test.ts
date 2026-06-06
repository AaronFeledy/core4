import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { smokeWindowsBinary } from "../../../scripts/smoke-windows-binary.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

let workDir: string;

const writeFakeBinary = async (name: string, body: string): Promise<string> => {
  const path = join(workDir, name);
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
};

const GOOD_BINARY = `#!/bin/sh
case "$1" in
  --version) echo "9.9.9"; exit 0;;
  --help) echo "Lando v4 core: usage"; exit 0;;
  shellenv) echo "export LANDO_INSTALL_DIR=/opt/lando"; exit 0;;
  *) echo "unknown command" >&2; exit 2;;
esac
`;

const NONZERO_BINARY = `#!/bin/sh
echo "boom" >&2
exit 1
`;

const INVALID_UTF8_BINARY = `#!/bin/sh
case "$1" in
  --version) printf '\\377\\376'; exit 0;;
  *) echo "ok"; exit 0;;
esac
`;

const ALWAYS_OK_BINARY = `#!/bin/sh
echo "ok"
exit 0
`;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "smoke-win-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("smokeWindowsBinary", () => {
  test("passes for a binary that exits 0 with non-empty UTF-8 stdout and fails on a bogus command", async () => {
    const binary = await writeFakeBinary("good", GOOD_BINARY);
    await expect(smokeWindowsBinary(binary)).resolves.toBeUndefined();
  });

  test("rejects when the binary exits non-zero for a smoke subcommand", async () => {
    const binary = await writeFakeBinary("nonzero", NONZERO_BINARY);
    await expect(smokeWindowsBinary(binary)).rejects.toThrow();
  });

  test("rejects when stdout is not valid UTF-8", async () => {
    const binary = await writeFakeBinary("invalid-utf8", INVALID_UTF8_BINARY);
    await expect(smokeWindowsBinary(binary)).rejects.toThrow();
  });

  test("rejects when a bogus subcommand unexpectedly exits 0", async () => {
    const binary = await writeFakeBinary("always-ok", ALWAYS_OK_BINARY);
    await expect(smokeWindowsBinary(binary)).rejects.toThrow();
  });

  test("rejects when the binary path does not exist", async () => {
    await expect(smokeWindowsBinary(join(workDir, "does-not-exist"))).rejects.toThrow();
  });

  test("smokes the real compiled host binary when present", async () => {
    const candidates = [resolve(repoRoot, "dist/lando"), resolve(repoRoot, "core/dist/lando")];
    const existing = (
      await Promise.all(candidates.map(async (p) => ((await Bun.file(p).exists()) ? p : undefined)))
    ).find((p): p is string => p !== undefined);

    if (existing === undefined) {
      // No locally-built binary; the fake-binary cases above cover the logic.
      return;
    }

    await expect(smokeWindowsBinary(existing)).resolves.toBeUndefined();
  });
});
