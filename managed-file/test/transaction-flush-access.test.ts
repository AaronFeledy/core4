import { expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createStage, digestOf, finishAppliedMode, mutateEntry, snapshot } from "../src/transaction-fs.ts";
import type { Stage } from "../src/transaction-journal.ts";
import { fixture } from "./transaction-fixture.ts";

for (const operation of ["publish", "finish-mode"] as const) {
  test(`${operation} opens a writable handle when Windows requires write access to flush`, async () => {
    // Given an existing target and a durable, private stage ready for publication.
    const { appRoot } = await fixture();
    const target = join(appRoot, ".lando.yml");
    await fs.writeFile(target, "old", { mode: 0o640 });
    const before = await snapshot(target);
    if (!before.state.present) throw new Error("missing target");
    const backup = `.lando.yml.bak.${before.state.digest}`;
    await fs.writeFile(join(appRoot, backup), before.bytes, { mode: 0o600 });
    const bytes = new TextEncoder().encode("new");
    let stage: Stage | undefined;
    await createStage(`${target}.lando-stage.test`, bytes, (created) => {
      stage = created;
    });
    if (stage === undefined) throw new Error("missing stage");
    const entry = {
      path: ".lando.yml",
      before: { ...before.state, backup },
      after: { present: true as const, digest: digestOf(bytes), mode: before.state.mode },
      stage,
    };
    if (operation === "finish-mode") await fs.rename(stage.path, target);

    const originalOpen = fs.open;
    const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path !== target) return handle;
      const sync = handle.sync.bind(handle);
      const writable =
        typeof flags === "number" ? (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0 : flags !== "r";
      handle.sync = () =>
        writable
          ? sync()
          : Promise.reject(Object.assign(new Error("read-only flush"), { code: "EPERM", syscall: "fsync" }));
      return handle;
    });
    try {
      // When publication or interrupted mode recovery flushes the final file.
      await (operation === "publish" ? mutateEntry(appRoot, entry) : finishAppliedMode(appRoot, entry));
      // Then the replacement bytes and intended mode are durable and verifiable.
      expect((await snapshot(target)).state).toEqual(entry.after);
    } finally {
      open.mockRestore();
    }
  });
}
