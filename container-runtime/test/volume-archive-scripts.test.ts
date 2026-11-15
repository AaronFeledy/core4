import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeUstarHeader } from "../src/tar.ts";
import {
  classifyVolumeArchiveCommand,
  volumeArchiveDiscardStagingCommand,
  volumeArchiveDisposeCommand,
  volumeArchiveExportCommand,
  volumeArchiveExtractCommand,
  volumeArchivePublishCommand,
  volumeArchivePublishScript,
  volumeArchiveReconcileScript,
  volumeSnapshotCaptureCommand,
  volumeSnapshotExtractCommand,
} from "../src/volume-archive.ts";

const id = "0b5d4f3a-8a0e-4b7f-9a1b-2c3d4e5f6a7b";
const replacedName = `.lando-replaced-${id}`;
const importName = `.lando-import-${id}`;

const runShell = async (cwd: string, script: string) => {
  const child = Bun.spawn(["bash", "-c", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const oneFileTar = (name: string, contents: string): Uint8Array => {
  const payload = new TextEncoder().encode(contents);
  const header = encodeUstarHeader({ name, size: payload.byteLength, mode: 0o644, typeflag: "0" });
  const padded = new Uint8Array(Math.ceil(payload.byteLength / 512) * 512);
  padded.set(payload);
  const output = new Uint8Array(header.byteLength + padded.byteLength + 1024);
  output.set(header);
  output.set(padded, header.byteLength);
  return output;
};

const runShellWithStdin = async (cwd: string, script: string, input: Uint8Array) => {
  const child = Bun.spawn(["bash", "-c", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  child.stdin.end();
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { stderr, exitCode };
};

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-volume-script-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const seedStaging = async (root: string, files: ReadonlyArray<readonly [string, string]>) => {
  const staging = join(root, importName);
  await mkdir(staging, { recursive: true });
  for (const [name, contents] of files) {
    const target = join(staging, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await chmod(staging, 0o750);
};

describe("volume archive publication", () => {
  test("moves old entries aside, installs staging, and applies the staging root mode", async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, "old-dir"));
      await writeFile(join(root, "old-dir", "kept.txt"), "old");
      await writeFile(join(root, "old file.txt"), "old");
      await writeFile(join(root, "-leading-dash"), "old");
      await writeFile(join(root, "line\nbreak"), "old");
      await symlink("missing-target", join(root, "dangling"));
      await seedStaging(root, [
        ["new.txt", "new"],
        ["nested/value.txt", "nested"],
      ]);

      const result = await runShell(root, volumeArchivePublishScript(id));

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual([replacedName, "nested", "new.txt"].sort());
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
      expect((await readdir(join(root, replacedName))).sort()).toEqual(
        ["-leading-dash", "dangling", "line\nbreak", "old file.txt", "old-dir"].sort(),
      );
      expect((await lstat(join(root, replacedName, "dangling"))).isSymbolicLink()).toBe(true);
      expect((await stat(root)).mode & 0o777).toBe(0o750);
      expect(await readdir(join(root, importName)).catch(() => null)).toBeNull();
    });
  });

  test("is idempotent after the commit point: a rerun with staging gone succeeds", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "old.txt"), "old");
      await seedStaging(root, [["new.txt", "new"]]);
      expect((await runShell(root, volumeArchivePublishScript(id))).exitCode).toBe(0);

      const rerun = await runShell(root, volumeArchivePublishScript(id));

      expect(rerun.exitCode).toBe(0);
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
    });
  });

  test("fails when neither staging nor a replaced copy exists", async () => {
    await withRoot(async (root) => {
      const result = await runShell(root, volumeArchivePublishScript(id));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("staging");
    });
  });
});

test.each([0, 1, 2])(
  "resumes publication after %i evacuated entries without moving installed data",
  async (evacuated) => {
    await withRoot(async (root) => {
      const oldNames = ["old-1.txt", "old-2.txt", "old-3.txt"];
      await seedStaging(root, [
        ["new-1.txt", "new"],
        ["new-2.txt", "new"],
        ["new-3.txt", "new"],
      ]);
      await mkdir(join(root, replacedName));
      for (const [index, name] of oldNames.entries()) {
        if (index < evacuated) await writeFile(join(root, replacedName, name), "old");
        else await writeFile(join(root, name), "old");
      }

      const result = await runShell(root, volumeArchivePublishScript(id));

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).filter((name) => name.startsWith(".lando-"))).toEqual([replacedName]);
      expect((await readdir(root)).filter((name) => name.startsWith("new-")).sort()).toEqual([
        "new-1.txt",
        "new-2.txt",
        "new-3.txt",
      ]);
      expect((await readdir(join(root, replacedName))).sort()).toEqual([...oldNames].sort());
    });
  },
);

test.each([1, 2])(
  "resumes installation after %i installed entries without evacuating them again",
  async (installed) => {
    await withRoot(async (root) => {
      await mkdir(join(root, replacedName));
      for (const name of ["old-1.txt", "old-2.txt", "old-3.txt"]) {
        await writeFile(join(root, replacedName, name), "old");
      }
      const staged = ["new-1.txt", "new-2.txt", "new-3.txt"];
      await seedStaging(
        root,
        staged.slice(installed).map((name) => [name, "new"] as const),
      );
      for (const name of staged.slice(0, installed)) await writeFile(join(root, name), "new");
      await writeFile(join(root, `.lando-installing-${id}`), "");

      const result = await runShell(root, volumeArchivePublishScript(id));

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).filter((name) => name.startsWith(".lando-")).sort()).toEqual([
        replacedName,
      ]);
      expect((await readdir(root)).filter((name) => name.startsWith("new-")).sort()).toEqual(
        [...staged].sort(),
      );
      // Installed entries stayed in the root; only the old copy remains for disposal.
      expect((await readdir(join(root, replacedName))).sort()).toEqual([
        "old-1.txt",
        "old-2.txt",
        "old-3.txt",
      ]);
    });
  },
);

test("a rerun with staging gone and a replaced copy only removes a leftover marker", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "live.txt"), "live");
    await mkdir(join(root, replacedName));
    await writeFile(join(root, replacedName, "old.txt"), "old");
    await writeFile(join(root, `.lando-installing-${id}`), "");

    const result = await runShell(root, volumeArchivePublishScript(id));

    expect(result.exitCode).toBe(0);
    expect(await readdir(join(root, replacedName))).toEqual(["old.txt"]);
    expect(await readFile(join(root, "live.txt"), "utf8")).toBe("live");
    expect(await Bun.file(join(root, `.lando-installing-${id}`)).exists()).toBe(false);
  });
});

test("one failed move stops installation and keeps the remaining staged data", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, replacedName));
    await writeFile(join(root, replacedName, "old.txt"), "old");
    await seedStaging(root, [
      ["A-blocked", "new"],
      ["z1.txt", "new"],
      ["z2.txt", "new"],
    ]);
    await writeFile(join(root, `.lando-installing-${id}`), "");
    // An installed entry already occupies the staged name, so this single move fails.
    await mkdir(join(root, "A-blocked"));
    await writeFile(join(root, "A-blocked", "occupant"), "occupied");

    const failed = await runShell(root, volumeArchivePublishScript(id));

    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(join(root, importName, "A-blocked"), "utf8")).toBe("new");
    expect(await readFile(join(root, importName, "z1.txt"), "utf8")).toBe("new");
    expect(await readFile(join(root, importName, "z2.txt"), "utf8")).toBe("new");
    expect(await readFile(join(root, replacedName, "old.txt"), "utf8")).toBe("old");
    expect(await Bun.file(join(root, `.lando-installing-${id}`)).exists()).toBe(true);
  });
});

test("a failed install propagates and keeps the previous copy recoverable", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, replacedName));
    await writeFile(join(root, replacedName, "old.txt"), "old");
    await seedStaging(root, [["new.txt", "new"]]);
    await writeFile(join(root, `.lando-installing-${id}`), "");
    await chmod(join(root, importName), 0o555);

    const failed = await runShell(root, volumeArchivePublishScript(id));

    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(join(root, replacedName, "old.txt"), "utf8")).toBe("old");
    expect(await Bun.file(join(root, "new.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, `.lando-installing-${id}`)).exists()).toBe(true);

    await chmod(join(root, importName), 0o750);
    const resumed = await runShell(root, volumeArchivePublishScript(id));
    expect(resumed.exitCode).toBe(0);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
  });
});

test("extraction reconciles an earlier committed transaction before staging new data", async () => {
  await withRoot(async (root) => {
    const previousId = "11111111-1111-4111-8111-111111111111";
    const previousImport = `.lando-import-${previousId}`;
    const previousReplaced = `.lando-replaced-${previousId}`;
    await mkdir(join(root, previousImport));
    await writeFile(join(root, previousImport, "previous.txt"), "previous");
    await mkdir(join(root, previousReplaced));
    await writeFile(join(root, previousReplaced, "older.txt"), "older");
    const command = volumeArchiveExtractCommand(id)[2] ?? "";
    const script = command.replaceAll("/lando-data", root);

    const result = await runShellWithStdin(root, script, oneFileTar("new.txt", "new"));

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(root, previousImport)).exists()).toBe(false);
    expect(await Bun.file(join(root, previousReplaced)).exists()).toBe(false);
    expect(await readFile(join(root, "previous.txt"), "utf8")).toBe("previous");
    expect(await readFile(join(root, importName, "new.txt"), "utf8")).toBe("new");
  });
});

describe("volume archive reconciliation", () => {
  test("finishes a partially installed publication and only then disposes the old copy", async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, replacedName));
      for (const name of ["old-1.txt", "old-2.txt"]) {
        await writeFile(join(root, replacedName, name), "old");
      }
      await seedStaging(root, [["new-2.txt", "new"]]);
      await writeFile(join(root, "new-1.txt"), "new");
      await writeFile(join(root, `.lando-installing-${id}`), "");

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["new-1.txt", "new-2.txt"]);
      expect(await Bun.file(join(root, replacedName)).exists()).toBe(false);
      expect(await Bun.file(join(root, importName)).exists()).toBe(false);
      expect(await Bun.file(join(root, `.lando-installing-${id}`)).exists()).toBe(false);
    });
  });

  test("finishes a partially evacuated publication before installing", async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, replacedName));
      await writeFile(join(root, replacedName, "old-1.txt"), "old");
      await writeFile(join(root, "old-2.txt"), "old");
      await seedStaging(root, [["new.txt", "new"]]);

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["new.txt"]);
      expect(await Bun.file(join(root, replacedName)).exists()).toBe(false);
    });
  });

  test("removes staging from a transaction that never committed", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "live.txt"), "live");
      await seedStaging(root, [["new.txt", "new"]]);

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["live.txt"]);
    });
  });

  test("finishes a publication that crossed the commit point, then disposes", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "old.txt"), "old");
      await seedStaging(root, [["new.txt", "new"]]);
      await mkdir(join(root, replacedName));
      await writeFile(join(root, replacedName, "partially-moved.txt"), "old");

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["new.txt"]);
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
    });
  });

  test("disposes a replaced copy whose publication already finished", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "live.txt"), "live");
      await mkdir(join(root, replacedName));
      await writeFile(join(root, replacedName, "old.txt"), "old");

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["live.txt"]);
    });
  });

  test.each([
    ["uncommitted staging", true, false],
    ["a published replaced copy", false, true],
    ["no other leftover", false, false],
  ] as const)("removes an installing marker left beside %s", async (_label, staging, replaced) => {
    await withRoot(async (root) => {
      await writeFile(join(root, "live.txt"), "live");
      if (staging) await seedStaging(root, [["new.txt", "new"]]);
      if (replaced) await mkdir(join(root, replacedName));
      await writeFile(join(root, `.lando-installing-${id}`), "");

      const result = await runShell(root, volumeArchiveReconcileScript());

      expect(result.exitCode).toBe(0);
      expect((await readdir(root)).sort()).toEqual(["live.txt"]);
    });
  });

  test("leaves reserved witness and witness staging entries untouched", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, ".lando-volume-witness.json"), "witness");
      await mkdir(join(root, ".lando-witness-stage-target"));
      await writeFile(join(root, ".lando-witness-stage-target", "record"), "stage");
      await seedStaging(root, [["new.txt", "new"]]);

      expect((await runShell(root, volumeArchiveReconcileScript())).exitCode).toBe(0);

      expect(await readFile(join(root, ".lando-volume-witness.json"), "utf8")).toBe("witness");
      expect(await readFile(join(root, ".lando-witness-stage-target", "record"), "utf8")).toBe("stage");
      // Staging alone was never committed, so reconciliation discards it.
      expect(await readFile(join(root, "new.txt"), "utf8").catch(() => null)).toBeNull();
    });
  });
});

describe("volume archive helper classification", () => {
  test.each([
    [volumeArchiveExportCommand(), "export"],
    [volumeSnapshotCaptureCommand(), "snapshot-capture"],
  ] as const)("classifies %j helpers by their stable marker", (command, kind) => {
    expect(classifyVolumeArchiveCommand(command)).toEqual({ kind });
  });

  test("classifies every transactional command with its transaction id", () => {
    const calls = [
      [volumeArchiveExtractCommand(id), "extract"],
      [volumeArchivePublishCommand(id), "publish"],
      [volumeArchiveDisposeCommand(id), "dispose"],
      [volumeArchiveDiscardStagingCommand(id), "discard"],
      [volumeSnapshotExtractCommand(id), "snapshot-extract"],
    ] as const;
    for (const [command, kind] of calls) {
      expect(classifyVolumeArchiveCommand(command)).toEqual({ kind, id });
    }
  });

  test("returns unknown for a command that is not a volume archive helper", () => {
    expect(classifyVolumeArchiveCommand(["sh", "-c", "echo hi"]).kind).toBe("unknown");
    expect(classifyVolumeArchiveCommand(["true"]).kind).toBe("unknown");
  });
});

describe("volume archive discard", () => {
  const discardIn = (root: string) => {
    const command = volumeArchiveDiscardStagingCommand(id);
    return runShell(root, command[2]!.replaceAll("/lando-data", root));
  };

  test("removes staging that never reached the commit point", async () => {
    await withRoot(async (root) => {
      await seedStaging(root, [["new.txt", "new"]]);

      expect((await discardIn(root)).exitCode).toBe(0);
      expect(await Bun.file(join(root, importName)).exists()).toBe(false);
    });
  });

  test("refuses to remove staging after the commit point", async () => {
    await withRoot(async (root) => {
      await seedStaging(root, [["new.txt", "new"]]);
      await mkdir(join(root, replacedName));

      expect((await discardIn(root)).exitCode).toBe(0);
      expect(await readFile(join(root, importName, "new.txt"), "utf8")).toBe("new");
    });
  });

  test("refuses to remove staging once installation recorded its marker", async () => {
    await withRoot(async (root) => {
      await seedStaging(root, [["new.txt", "new"]]);
      await writeFile(join(root, `.lando-installing-${id}`), "");

      expect((await discardIn(root)).exitCode).toBe(0);
      expect(await readFile(join(root, importName, "new.txt"), "utf8")).toBe("new");
    });
  });
});
