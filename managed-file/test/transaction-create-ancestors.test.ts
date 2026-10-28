import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

for (const timing of ["before-link", "after-link"] as const) {
  test(`rejects same-inode higher-ancestor redirection ${timing}`, async () => {
    // Given a nested parent whose inode survives moving its ancestor outside the app
    const { root, appRoot, transactions } = await fixture((at, index) =>
      timing === "before-link" && at === "before-create-link" && index === 1
        ? Effect.promise(redirect)
        : Effect.void,
    );
    const ancestor = join(appRoot, "a");
    const outside = join(root, "moved");
    await fs.mkdir(join(ancestor, "b"), { recursive: true });
    const parent = await fs.lstat(join(ancestor, "b"));
    async function redirect() {
      await fs.rename(ancestor, outside);
      await fs.symlink(outside, ancestor, "junction");
    }
    const originalLink = fs.link;
    const link = spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (timing === "after-link" && String(target).endsWith("/file")) await redirect();
    });

    // When publication encounters the redirect before or immediately after linking
    try {
      const outcome = await scoped(
        Effect.result(
          transactions.run({
            appRoot,
            operations: [
              { kind: "create", path: "0-prefix", content: "PREFIX" },
              { kind: "create", path: "a/b/file", content: "OUTSIDE", mode: 0o755 },
            ],
          }),
        ),
      );

      // Then containment fails despite the unchanged immediate-parent inode
      expect(await fs.lstat(join(ancestor, "b"))).toMatchObject({ dev: parent.dev, ino: parent.ino });
      expect(outcome).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } });
      expect(await fs.readdir(join(outside, "b"))).not.toContain("file");
      expect(await fs.readFile(join(appRoot, "0-prefix"), "utf8")).toBe("PREFIX");
      expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("committing");
      const recovery = await scoped(Effect.result(transactions.recover(appRoot)));
      expect(recovery).toMatchObject({ _tag: "Failure", failure: { reason: "blocked" } });
      expect((await fs.lstat(ancestor)).isSymbolicLink()).toBe(true);
    } finally {
      link.mockRestore();
    }
  });
}

for (const checkpoint of ["prepared", "create-linked", "after-mutation"] as const) {
  test(`blocks same-inode higher-ancestor redirection during ${checkpoint} recovery`, async () => {
    // Given a pending, linked, or published create moved outside the app after a crash
    const { root, appRoot, transactions } = await fixture((at) =>
      at === checkpoint ? Effect.fail("crash") : Effect.void,
    );
    await fs.mkdir(join(appRoot, "a/b"), { recursive: true });
    await scoped(
      Effect.result(
        transactions.run({
          appRoot,
          operations: [{ kind: "create", path: "a/b/file", content: "OURS", mode: 0o755 }],
        }),
      ),
    );
    const parent = await fs.lstat(join(appRoot, "a/b"));
    const outside = join(root, "moved");
    await fs.rename(join(appRoot, "a"), outside);
    await fs.symlink(outside, join(appRoot, "a"), "junction");
    const before = await fs.readdir(join(outside, "b"));
    const beforeStats = await Promise.all(before.map((name) => fs.lstat(join(outside, "b", name))));

    // When recovery would publish, finish chmod, or adopt the redirected inode
    const outcome = await scoped(Effect.result(transactions.recover(appRoot)));

    // Then it blocks without mutating the moved subtree
    expect(await fs.lstat(join(appRoot, "a/b"))).toMatchObject({ dev: parent.dev, ino: parent.ino });
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { reason: "blocked" } });
    expect(await fs.readdir(join(outside, "b"))).toEqual(before);
    for (const [index, name] of before.entries()) {
      const stats = beforeStats[index];
      expect(await fs.lstat(join(outside, "b", name))).toMatchObject({
        ino: stats?.ino,
        mode: stats?.mode,
        nlink: stats?.nlink,
      });
      expect(await fs.readFile(join(outside, "b", name), "utf8")).toBe("OURS");
    }
    expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
  });
}
