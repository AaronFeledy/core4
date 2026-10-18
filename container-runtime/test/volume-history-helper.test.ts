import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VOLUME_HISTORY_MODE,
  volumeHistoryInitCommand,
  volumeHistoryModeCheckCommand,
} from "../src/volume-history-helper.ts";

const invoke = async (command: readonly string[]) => {
  const helperSource = command[2];
  if (helperSource === undefined) throw new Error("Expected an inline history helper");
  const child = Bun.spawn([process.execPath, command[1] ?? "-e", helperSource, ...command.slice(3)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("chmods the volume root to 1777 without wiping files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-history-"));
  try {
    await Bun.write(join(root, "appserver.bash_history"), "ls\n");
    const result = await invoke(volumeHistoryInitCommand(root));
    expect(result.code).toBe(0);
    const mode = (await stat(root)).mode & 0o7777;
    expect(mode).toBe(VOLUME_HISTORY_MODE);
    expect(await Bun.file(join(root, "appserver.bash_history")).text()).toBe("ls\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mode check exits 0 only when the volume root is 1777", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-history-mode-"));
  try {
    expect((await invoke(volumeHistoryModeCheckCommand(root))).code).not.toBe(0);
    expect((await invoke(volumeHistoryInitCommand(root))).code).toBe(0);
    expect((await invoke(volumeHistoryModeCheckCommand(root))).code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
