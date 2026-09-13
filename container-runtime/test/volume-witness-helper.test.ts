import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VOLUME_WITNESS_FILE, volumeWitnessCommand } from "../src/volume-witness-helper.ts";

const invoke = async (root: string, ownerRoot: string, operation: "adopt" | "read" = "adopt") => {
  const command = volumeWitnessCommand({ root, ownerRoot, operation, generation: randomUUID() });
  const child = Bun.spawn([process.execPath, ...command.slice(1)], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("concurrent same-owner adopters publish and re-read one durable generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-witness-"));
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => invoke(root, "/owner with 'quotes'\n$()")),
    );
    expect(results.map((result) => result.code)).toEqual(Array(8).fill(0));
    expect(new Set(results.map((result) => result.stdout)).size).toBe(1);
    const first = results[0];
    if (!first) throw new Error("Expected concurrent adoption results");
    expect((await invoke(root, "/owner with 'quotes'\n$()", "read")).stdout).toBe(first.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent foreign owners cannot overwrite the winning witness", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-witness-"));
  try {
    const results = await Promise.all([invoke(root, "/one"), invoke(root, "/two")]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const persisted = await readFile(join(root, VOLUME_WITNESS_FILE), "utf8");
    expect(results.find((result) => result.code === 0)?.stdout.trim()).toBe(persisted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["symlink", "mode", "invalid", "relative-owner"])(
  "rejects an unsafe existing witness: %s",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-witness-"));
    try {
      const path = join(root, VOLUME_WITNESS_FILE);
      const valid = JSON.stringify({ version: 1, generation: randomUUID(), ownerRoot: "/owner" });
      if (kind === "symlink") {
        await writeFile(join(root, "other"), valid, { mode: 0o600 });
        await symlink("other", path);
      } else {
        await writeFile(
          path,
          kind === "relative-owner"
            ? JSON.stringify({ version: 1, generation: randomUUID(), ownerRoot: "relative" })
            : kind === "mode"
              ? valid
              : "invalid",
          { mode: 0o600 },
        );
        if (kind === "mode") await chmod(path, 0o666);
      }
      expect((await invoke(root, kind === "relative-owner" ? "relative" : "/owner")).code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("recreating the volume directory does not reuse its former generation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lando-witness-"));
  try {
    const firstRoot = await mkdtemp(join(parent, "volume-"));
    const first = await invoke(firstRoot, "/owner");
    await rm(firstRoot, { recursive: true });
    await mkdir(firstRoot);
    const second = await invoke(firstRoot, "/owner");
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toBe(first.stdout);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a symlinked ancestor of the requested volume root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lando-witness-parent-"));
  try {
    const real = await mkdtemp(join(parent, "real-"));
    await mkdir(join(real, "volume"));
    await symlink(real, join(parent, "alias"));
    expect((await invoke(join(parent, "alias", "volume"), "/owner")).code).toBe(1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("read-only observation does not create a missing witness", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-witness-read-"));
  try {
    const result = await invoke(root, "/owner", "read");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("null");
    expect(await Bun.file(join(root, VOLUME_WITNESS_FILE)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
