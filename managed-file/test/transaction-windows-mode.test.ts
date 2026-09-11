import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  createStage,
  digestOf,
  finishAppliedMode,
  mutateEntry,
  sameState,
  snapshot,
} from "../src/transaction-fs.ts";
import type { Entry, Stage } from "../src/transaction-journal.ts";
import { preflight } from "../src/transaction-preflight.ts";
import { fixture } from "./transaction-fixture.ts";

const privateFileAccess = {
  enforce: () => Promise.resolve(),
  verify: () => Promise.resolve(),
};

for (const platform of ["win32", "linux"] as const) {
  test(`compares writable and read-only file states using ${platform} permissions`, () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      const state = { present: true as const, digest: digestOf("content"), mode: 0o600 };
      expect(sameState(state, { ...state, mode: 0o666 })).toBe(platform === "win32");
      expect(sameState({ ...state, mode: 0o400 }, { ...state, mode: 0o444 })).toBe(platform === "win32");
      expect(sameState(state, { ...state, mode: 0o444 })).toBe(false);
      expect(sameState(state, { ...state, digest: digestOf("changed") })).toBe(false);
      expect(sameState(state, { present: false })).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
}

for (const operation of ["publish", "finish-mode"] as const) {
  test(`${operation} verifies a new Landofile when Windows reports chmod(0600) as 0666`, async () => {
    // Given a new-file plan and Windows chmod semantics, not POSIX mode persistence.
    const { appRoot } = await fixture();
    const target = join(appRoot, ".lando.yml");
    const bytes = new TextEncoder().encode("name: windows-app\n");
    let stage: Stage | undefined;
    await createStage({
      path: `${target}.lando-stage.windows`,
      bytes,
      record: (created) => {
        stage = created;
      },
      privateFileAccess,
    });
    if (stage === undefined) throw new Error("missing stage");
    await fs.chmod(stage.path, 0o666);
    const entry: Entry = {
      path: ".lando.yml",
      before: { present: false },
      after: { present: true, digest: digestOf(bytes), mode: 0o600 },
      stage,
    };
    if (operation === "finish-mode") await fs.rename(stage.path, target);
    const originalPlatform = process.platform;
    const originalOpen = fs.open;
    const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path === target) {
        const chmod = handle.chmod.bind(handle);
        handle.chmod = (requested) => chmod((Number(requested) & 0o200) !== 0 ? 0o666 : 0o444);
      }
      return handle;
    });
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      // When the coordinator publishes or finishes an interrupted mode application.
      await (operation === "publish"
        ? mutateEntry(appRoot, entry, privateFileAccess)
        : finishAppliedMode(appRoot, entry, privateFileAccess));
      // Then the bytes are committed and recovery recognizes the synthetic mode as applied.
      expect((await snapshot(target)).state).toEqual({ present: true, digest: digestOf(bytes), mode: 0o666 });
      expect(await fs.readFile(target, "utf8")).toBe("name: windows-app\n");
      expect(
        await preflight(
          appRoot,
          { id: "windows", root: appRoot, state: "committing", entries: [entry] },
          privateFileAccess,
        ),
      ).toEqual([{ entry, disposition: "applied" }]);
    } finally {
      open.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
}
