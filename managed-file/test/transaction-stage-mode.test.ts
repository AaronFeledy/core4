import { expect, test } from "bun:test";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStage, digestOf, mutateEntry, snapshot } from "../src/transaction-fs.ts";
import type { Stage } from "../src/transaction-journal.ts";
import { fixture } from "./transaction-fixture.ts";

for (const platform of ["win32", "linux"] as const) {
  test(`checks stage permissions using ${platform} semantics before publishing`, async () => {
    // Given a writable stage with Windows-style synthetic permission bits.
    const { appRoot } = await fixture();
    const target = join(appRoot, ".lando.yml");
    const stagePath = `${target}.lando-stage.test`;
    await writeFile(target, "old");
    const before = await snapshot(target);
    if (!before.state.present) throw new Error("missing target");
    const backup = ".lando.yml.bak.test";
    await writeFile(join(appRoot, backup), before.bytes, { mode: 0o600 });
    const bytes = new TextEncoder().encode("new");
    let stage: Stage | undefined;
    await createStage(stagePath, bytes, (created) => {
      stage = created;
    });
    if (stage === undefined) throw new Error("missing stage");
    await chmod(stagePath, 0o666);
    expect((await lstat(stagePath)).mode & 0o777).toBe(0o666);
    const entry = {
      path: ".lando.yml",
      before: { ...before.state, backup },
      after: { present: true as const, digest: digestOf(bytes), mode: before.state.mode },
      stage,
    };
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      // When commit validates and publishes the stage.
      const mutation = mutateEntry(appRoot, entry);
      // Then Windows accepts its synthetic mode; POSIX still rejects a public stage.
      if (platform === "win32") {
        await mutation;
        expect(await readFile(target, "utf8")).toBe("new");
      } else {
        await expect(mutation).rejects.toMatchObject({ reason: "conflict" });
        expect(await readFile(target, "utf8")).toBe("old");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
}
