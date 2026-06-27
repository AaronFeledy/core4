import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

interface StateStoreBoundaryOffender {
  readonly file: string;
  readonly signals: ReadonlyArray<string>;
}

interface StateStoreBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<StateStoreBoundaryOffender>;
}

interface StateStoreBoundaryModule {
  readonly checkStateStoreBoundary: (options?: {
    readonly root?: string;
  }) => Promise<StateStoreBoundaryResult>;
}

const stateStoreBoundaryModulePath = ["..", "..", "..", "scripts", "check-state-store-boundary.ts"].join("/");
const stateStoreBoundaryModuleUrl = new URL(stateStoreBoundaryModulePath, import.meta.url).href;
const { checkStateStoreBoundary } = (await import(stateStoreBoundaryModuleUrl)) as StateStoreBoundaryModule;

const makeFixtureRoot = async (): Promise<string> =>
  fs.mkdtemp(join(tmpdir(), "lando-state-store-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content, "utf8");
};

describe("state-store boundary lint gate", () => {
  test("reports files that hand-roll atomic write, lockfile, and version envelope together", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/foo/offender.ts",
        `import { open, rename, unlink, writeFile } from "node:fs/promises";

export const writeDurableState = async (target: string, data: unknown): Promise<void> => {
  const lock = \`${"${target}"}.lock\`;
  const handle = await open(lock, "wx");
  try {
    const tempPath = \`${"${target}"}.tmp-${"${crypto.randomUUID()}"}\`;
    await writeFile(tempPath, JSON.stringify({ version: 1, data }));
    await rename(tempPath, target);
  } catch (error) {
    await unlink(lock).catch(() => undefined);
    if ((error as { code?: string }).code === "EEXIST") return;
    throw error;
  } finally {
    await handle.close();
  }
};
`,
      );

      const result = await checkStateStoreBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map((offender) => `${relative(root, offender.file)}:${offender.signals.join(",")}`),
      ).toEqual(["core/src/foo/offender.ts:atomic-write-rename,lockfile,version-envelope"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("allows a legitimate single-concern atomic writer", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/foo/legit-atomic.ts",
        `import { rename, writeFile } from "node:fs/promises";

export const writeAtomic = async (target: string, content: string): Promise<void> => {
  const tempPath = \`${"${target}"}.tmp-${"${crypto.randomUUID()}"}\`;
  await writeFile(tempPath, content);
  await rename(tempPath, target);
};
`,
      );

      expect(await checkStateStoreBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("passes for the real repository", async () => {
    expect(await checkStateStoreBoundary()).toEqual({ ok: true, offenders: [] });
  });
});
