import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit } from "effect";

import type { ManagedFile } from "@lando/sdk/schema";

import { makeDiskBackend, makeManagedFileService } from "../../src/managed-file/service.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runScoped = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const file = (overrides: Partial<ManagedFile> & Pick<ManagedFile, "id" | "path">): ManagedFile => ({
  owner: "test",
  mode: "file",
  format: "text",
  content: { kind: "text", value: "hello world\n" },
  ...overrides,
});

describe("ManagedFileService (in-memory)", () => {
  test("create writes marker + body, then re-apply skips unchanged", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:greeting", path: "greeting.txt" });

    const first = await runScoped(store.service.apply([mf]));
    expect(first.entries[0]?.action).toBe("create");
    const written = store.read("greeting.txt");
    expect(written).toContain("lando-generated:a:greeting");
    expect(written).toContain("hello world");
    expect(store.ledger()).toHaveLength(1);

    const second = await runScoped(store.service.apply([mf]));
    expect(second.entries[0]?.action).toBe("skip-unchanged");
  });

  test("changed desired content produces update", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:cfg", path: "cfg.txt" });
    await runScoped(store.service.apply([mf]));

    const changed = file({ id: "a:cfg", path: "cfg.txt", content: { kind: "text", value: "new body\n" } });
    const result = await runScoped(store.service.apply([changed]));
    expect(result.entries[0]?.action).toBe("update");
    expect(store.read("cfg.txt")).toContain("new body");
  });

  test("JSON without a marker slot still follows a managed ledger", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({
      id: "a:json-array",
      path: "array.json",
      format: "json",
      content: { kind: "structured", data: ["old"] },
    });
    await runScoped(store.service.apply([mf]));
    expect(store.read("array.json")).not.toContain("x-lando-generated");

    const changed = file({
      id: "a:json-array",
      path: "array.json",
      format: "json",
      content: { kind: "structured", data: ["new"] },
    });
    const result = await runScoped(store.service.apply([changed]));
    expect(result.entries[0]?.action).toBe("update");
    expect(store.ledger()[0]?.state).toBe("managed");
    expect(store.read("array.json")).toContain("new");
  });

  test("JSON body data cannot override the ownership marker", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({
      id: "a:json-marker",
      path: "marker.json",
      format: "json",
      content: { kind: "structured", data: { "x-lando-generated": "user", value: true } },
    });

    await runScoped(store.service.apply([mf]));
    expect(JSON.parse(store.read("marker.json") ?? "{}")["x-lando-generated"]).toBe("a:json-marker");
    const second = await runScoped(store.service.apply([mf]));
    expect(second.entries[0]?.action).toBe("skip-unchanged");
    expect(store.ledger()[0]?.state).toBe("managed");
  });

  test("pre-existing unmarked user file is adopted, never clobbered", async () => {
    const store = await run(makeTestManagedFileStore());
    store.seed("user.txt", "i wrote this by hand\n");
    const mf = file({ id: "a:user", path: "user.txt" });

    const result = await runScoped(store.service.apply([mf]));
    expect(result.entries[0]?.action).toBe("skip-adopted");
    expect(store.read("user.txt")).toBe("i wrote this by hand\n");
    expect(store.ledger()[0]?.state).toBe("adopted");
  });

  test("in-place edit under a present marker is a conflict and is not overwritten", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:conf", path: "conf.txt" });
    await runScoped(store.service.apply([mf]));
    const edited = `${store.read("conf.txt")}user appended line\n`;
    store.seed("conf.txt", edited);

    const result = await runScoped(store.service.apply([mf]));
    expect(result.entries[0]?.action).toBe("conflict");
    expect(store.read("conf.txt")).toBe(edited);
  });

  test("onConflict overwrite backs up then updates", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:ov", path: "ov.txt", onConflict: "overwrite" });
    await runScoped(store.service.apply([mf]));
    store.seed("ov.txt", `${store.read("ov.txt")}tampered\n`);

    const result = await runScoped(store.service.apply([mf]));
    expect(result.entries[0]?.action).toBe("update");
    expect(result.entries[0]?.backup).toBeDefined();
    expect(store.read("ov.txt")).toContain("hello world");
  });

  test("onConflict fail raises a conflict error", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:f", path: "f.txt", onConflict: "fail" });
    await runScoped(store.service.apply([mf]));
    store.seed("f.txt", `${store.read("f.txt")}tampered\n`);

    const exit = await Effect.runPromiseExit(Effect.scoped(store.service.apply([mf])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error?._tag).toBe("ManagedFileError");
      expect(error?.reason).toBe("conflict");
    }
  });

  test("present marker without a ledger is treated as a conflict", async () => {
    const original = await run(makeTestManagedFileStore());
    const stale = file({
      id: "a:orphan",
      path: "orphan.txt",
      content: { kind: "text", value: "stale body\n" },
    });
    await runScoped(original.service.apply([stale]));
    const orphanedDisk = original.read("orphan.txt") ?? "";

    const store = await run(makeTestManagedFileStore());
    store.seed("orphan.txt", orphanedDisk);
    const desired = file({ id: "a:orphan", path: "orphan.txt", onConflict: "fail" });

    const exit = await Effect.runPromiseExit(Effect.scoped(store.service.apply([desired])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("conflict");
    }
    expect(store.read("orphan.txt")).toBe(orphanedDisk);

    const forced = await runScoped(store.service.apply([desired], { force: true }));
    const backup = forced.entries[0]?.backup;
    expect(forced.entries[0]?.action).toBe("update");
    expect(backup).toBeDefined();
    expect(backup === undefined ? null : store.read(backup)).toBe(orphanedDisk);
    expect(store.read("orphan.txt")).toContain("hello world");
  });

  test("force overrides a conflict", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:force", path: "force.txt" });
    await runScoped(store.service.apply([mf]));
    store.seed("force.txt", `${store.read("force.txt")}tampered\n`);

    const result = await runScoped(store.service.apply([mf], { force: true }));
    expect(result.entries[0]?.action).toBe("update");
  });

  test("multi-file apply resolves conflicts before writing", async () => {
    const store = await run(makeTestManagedFileStore());
    const first = file({ id: "a:first", path: "first.txt", content: { kind: "text", value: "before\n" } });
    const second = file({ id: "a:second", path: "second.txt", onConflict: "fail" });
    await runScoped(store.service.apply([first, second]));
    const firstBefore = store.read("first.txt");
    store.seed("second.txt", `${store.read("second.txt")}tampered\n`);

    const changedFirst = file({
      id: "a:first",
      path: "first.txt",
      content: { kind: "text", value: "after\n" },
    });
    const exit = await Effect.runPromiseExit(Effect.scoped(store.service.apply([changedFirst, second])));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(store.read("first.txt")).toBe(firstBefore);
  });

  test("adopt strips the marker so future applies skip", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:adopt", path: "adopt.txt" });
    await runScoped(store.service.apply([mf]));

    await run(store.service.adopt("adopt.txt"));
    expect(store.read("adopt.txt")).not.toContain("lando-generated");
    expect(store.read("adopt.txt")).toContain("hello world");

    const result = await runScoped(store.service.apply([mf]));
    expect(result.entries[0]?.action).toBe("skip-adopted");
  });

  test("adopt targets the default-base ledger entry for duplicate relative paths", async () => {
    const store = await run(makeTestManagedFileStore());
    const customBase = "/lando-memfs/custom";
    const custom = file({ id: "a:custom", path: "shared.txt", base: customBase });
    const local = file({ id: "a:local", path: "shared.txt" });
    await runScoped(store.service.apply([custom, local]));

    await run(store.service.adopt("shared.txt"));

    const entries = store.ledger();
    expect(entries.find((entry) => entry.base === customBase)?.state).toBe("managed");
    expect(entries.find((entry) => entry.base === undefined)?.state).toBe("adopted");
  });

  test("release flips ledger ownership to adopted without touching the file", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:rel", path: "rel.txt" });
    await runScoped(store.service.apply([mf]));
    const before = store.read("rel.txt");

    await run(store.service.release("rel.txt"));
    expect(store.ledger()[0]?.state).toBe("adopted");
    expect(store.read("rel.txt")).toBe(before);
  });

  test("release targets the default-base ledger entry for duplicate relative paths", async () => {
    const store = await run(makeTestManagedFileStore());
    const customBase = "/lando-memfs/custom";
    const custom = file({ id: "a:custom-release", path: "release.txt", base: customBase });
    const local = file({ id: "a:local-release", path: "release.txt" });
    await runScoped(store.service.apply([custom, local]));

    await run(store.service.release("release.txt"));

    const entries = store.ledger();
    expect(entries.find((entry) => entry.base === customBase)?.state).toBe("managed");
    expect(entries.find((entry) => entry.base === undefined)?.state).toBe("adopted");
  });

  test("removing a previously managed file deletes it and clears the ledger", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:rm", path: "rm.txt" });
    await runScoped(store.service.apply([mf]));

    const result = await run(store.service.remove({ id: "a:rm" }));
    expect(result.entries).toHaveLength(1);
    expect(store.read("rm.txt")).toBeNull();
    expect(store.ledger()).toHaveLength(0);
  });

  test("plan matches apply for the same inputs", async () => {
    const store = await run(makeTestManagedFileStore());
    const files = [
      file({ id: "a:1", path: "one.txt" }),
      file({ id: "a:2", path: "two.txt", mode: "block", content: { kind: "text", value: "block body" } }),
    ];
    const planned = await run(store.service.plan(files));
    const applied = await runScoped(store.service.apply(files));
    expect(planned.entries.map((e) => e.action)).toEqual(applied.entries.map((e) => e.action));
  });

  test("plan accounts for earlier ledger updates in the same batch", async () => {
    const store = await run(makeTestManagedFileStore());
    const original = file({ id: "a:batch", path: "batch.txt", content: { kind: "text", value: "old\n" } });
    await runScoped(store.service.apply([original]));

    const changed = file({ id: "a:batch", path: "batch.txt", content: { kind: "text", value: "new\n" } });
    const files = [changed, changed];
    const planned = await run(store.service.plan(files));
    const applied = await runScoped(store.service.apply(files));

    expect(planned.entries.map((e) => e.action)).toEqual(["update", "skip-unchanged"]);
    expect(applied.entries.map((e) => e.action)).toEqual(planned.entries.map((e) => e.action));
    expect(store.read("batch.txt")).toContain("new");
  });

  test("path escaping the base is rejected with reason path", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:esc", path: "../escape.txt" });
    const exit = await Effect.runPromiseExit(Effect.scoped(store.service.apply([mf])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("path");
    }
  });

  test("status reflects managed, conflict, and missing", async () => {
    const store = await run(makeTestManagedFileStore());
    await runScoped(store.service.apply([file({ id: "a:s", path: "s.txt" })]));
    let info = await run(store.service.status);
    expect(info[0]?.state).toBe("managed");

    store.seed("s.txt", `${store.read("s.txt")}edited\n`);
    info = await run(store.service.status);
    expect(info[0]?.state).toBe("conflict");
  });

  for (const format of ["text", "env", "yaml", "json"] as const) {
    test(`marker round-trips for format ${format}`, async () => {
      const store = await run(makeTestManagedFileStore());
      const content: ManagedFile["content"] =
        format === "text"
          ? { kind: "text", value: "line one\n" }
          : { kind: "structured", data: { FOO: "bar" } };
      const mf = file({ id: `a:${format}`, path: `out.${format}`, format, content });

      const created = await runScoped(store.service.apply([mf]));
      expect(created.entries[0]?.action).toBe("create");
      const second = await runScoped(store.service.apply([mf]));
      expect(second.entries[0]?.action).toBe("skip-unchanged");
    });
  }
});

describe("ManagedFileService block mode", () => {
  const blockFile = (value: string, overrides: Partial<ManagedFile> = {}): ManagedFile =>
    file({
      id: "b:settings",
      path: "settings.conf",
      mode: "block",
      content: { kind: "text", value },
      ...overrides,
    });

  test("create then re-apply is idempotent", async () => {
    const store = await run(makeTestManagedFileStore());
    const first = await runScoped(store.service.apply([blockFile("OWNED=1")]));
    expect(first.entries[0]?.action).toBe("create");
    const disk = store.read("settings.conf") ?? "";
    expect(disk).toContain(">>> lando:b:settings >>>");
    expect(disk).toContain("OWNED=1");

    const second = await runScoped(store.service.apply([blockFile("OWNED=1")]));
    expect(second.entries[0]?.action).toBe("skip-unchanged");
  });

  test("edits outside the block do not conflict; edits inside do", async () => {
    const store = await run(makeTestManagedFileStore());
    await runScoped(store.service.apply([blockFile("OWNED=1")]));

    store.seed("settings.conf", `${store.read("settings.conf")}\n# my own note\n`);
    const outside = await runScoped(store.service.apply([blockFile("OWNED=1")]));
    expect(outside.entries[0]?.action).toBe("skip-unchanged");

    store.seed("settings.conf", (store.read("settings.conf") ?? "").replace("OWNED=1", "HACKED=1"));
    const inside = await runScoped(store.service.apply([blockFile("OWNED=1")]));
    expect(inside.entries[0]?.action).toBe("conflict");
  });

  test("pre-existing file without a block fence is adopted, never appended", async () => {
    const store = await run(makeTestManagedFileStore());
    const userContent = "# user owned settings\nUSER=1\n";
    store.seed("settings.conf", userContent);

    const result = await runScoped(store.service.apply([blockFile("OWNED=1")]));

    expect(result.entries[0]?.action).toBe("skip-adopted");
    expect(store.read("settings.conf")).toBe(userContent);
    expect(store.read("settings.conf")).not.toContain(">>> lando:b:settings >>>");
    expect(store.ledger()[0]?.state).toBe("adopted");
  });

  test("present fence without a ledger is treated as a conflict", async () => {
    const original = await run(makeTestManagedFileStore());
    await runScoped(original.service.apply([blockFile("STALE=1")]));
    const orphanedDisk = original.read("settings.conf") ?? "";

    const store = await run(makeTestManagedFileStore());
    store.seed("settings.conf", orphanedDisk);
    const desired = blockFile("OWNED=1", { onConflict: "fail" });

    const exit = await Effect.runPromiseExit(Effect.scoped(store.service.apply([desired])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("conflict");
    }
    expect(store.read("settings.conf")).toBe(orphanedDisk);

    const forced = await runScoped(store.service.apply([desired], { force: true }));
    const backup = forced.entries[0]?.backup;
    expect(forced.entries[0]?.action).toBe("update");
    expect(backup).toBeDefined();
    expect(backup === undefined ? null : store.read(backup)).toContain("STALE=1");
    expect(store.read("settings.conf")).toContain("OWNED=1");
  });
});

describe("ManagedFileService (disk backend)", () => {
  const withTemp = async <T>(fn: (dirs: { base: string; dataRoot: string }) => Promise<T>): Promise<T> => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-mf-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mf-data-")));
    try {
      return await fn({ base, dataRoot });
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  };

  const makeService = (dirs: { base: string; dataRoot: string }) =>
    makeDiskBackend({ defaultBase: () => dirs.base, ledgerRoot: () => dirs.dataRoot }).pipe(
      Effect.flatMap(makeManagedFileService),
    );

  test("writes to real disk and persists a ledger that leaves no temp files", async () => {
    await withTemp(async (dirs) => {
      const service = await run(makeService(dirs));
      const result = await runScoped(service.apply([file({ id: "d:1", path: "real.txt" })]));
      expect(result.entries[0]?.action).toBe("create");

      const onDisk = await readFile(join(dirs.base, "real.txt"), "utf8");
      expect(onDisk).toContain("lando-generated:d:1");
      const baseEntries = await readdir(dirs.base);
      expect(baseEntries.some((name) => name.includes(".tmp-"))).toBe(false);

      const ledgerDir = (await readdir(join(dirs.dataRoot, "managed-files")))[0];
      const ledger = JSON.parse(
        await readFile(join(dirs.dataRoot, "managed-files", ledgerDir ?? "", "ledger.json"), "utf8"),
      );
      expect(ledger.version).toBe(1);
      expect(ledger.data.entries[0].id).toBe("d:1");
    });
  });

  test("a corrupt ledger is quarantined and apply still succeeds", async () => {
    await withTemp(async (dirs) => {
      const service = await run(makeService(dirs));
      await runScoped(service.apply([file({ id: "d:q", path: "q.txt" })]));
      const ledgerDir = join(
        dirs.dataRoot,
        "managed-files",
        (await readdir(join(dirs.dataRoot, "managed-files")))[0] ?? "",
      );
      await writeFile(join(ledgerDir, "ledger.json"), "{ not valid json");

      const result = await runScoped(service.apply([file({ id: "d:q2", path: "q2.txt" })]));
      expect(result.entries[0]?.action).toBe("create");
      const files = await readdir(ledgerDir);
      expect(files.some((name) => name.includes(".corrupt-"))).toBe(true);
    });
  });

  test("rejects writes through a symlinked directory that escapes the base", async () => {
    await withTemp(async (dirs) => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "lando-mf-outside-")));
      try {
        await symlink(outside, join(dirs.base, "linked"));
        const service = await run(makeService(dirs));

        const exit = await Effect.runPromiseExit(
          Effect.scoped(service.apply([file({ id: "d:link", path: "linked/escape.txt" })])),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
          expect(exit.cause.error.reason).toBe("path");
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("lifecycle operations honor a managed file custom base", async () => {
    await withTemp(async (dirs) => {
      const customBase = await realpath(await mkdtemp(join(tmpdir(), "lando-mf-custom-")));
      try {
        const service = await run(makeService(dirs));
        const mf = file({ id: "d:custom", path: "custom.txt", base: customBase });
        await runScoped(service.apply([mf]));

        const info = await run(service.status);
        expect(info[0]?.state).toBe("managed");

        await run(service.remove({ path: "custom.txt" }));
        const stillExists = await readFile(join(customBase, "custom.txt"), "utf8").then(
          () => true,
          () => false,
        );
        expect(stillExists).toBe(false);
      } finally {
        await rm(customBase, { recursive: true, force: true });
      }
    });
  });

  test("an adopted missing file is not recreated", async () => {
    await withTemp(async (dirs) => {
      const service = await run(makeService(dirs));
      const mf = file({ id: "d:adopt-missing", path: "adopt-missing.txt" });
      await runScoped(service.apply([mf]));
      await run(service.adopt("adopt-missing.txt"));
      await rm(join(dirs.base, "adopt-missing.txt"), { force: true });

      const result = await runScoped(service.apply([mf]));
      const exists = await readFile(join(dirs.base, "adopt-missing.txt"), "utf8").then(
        () => true,
        () => false,
      );

      expect(result.entries[0]?.action).toBe("skip-adopted");
      expect(exists).toBe(false);
    });
  });
});
