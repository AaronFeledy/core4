import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unmountPerformanceOverlay } from "../../../scripts/workflow-performance-stores.ts";

test.each([
  { mountpoint: 0, unmount: 0, expected: "unmount\ndelete\n", exit: 0 },
  { mountpoint: 32, unmount: 0, expected: "delete\n", exit: 0 },
  { mountpoint: 1, unmount: 0, expected: "", exit: 1 },
  { mountpoint: 0, unmount: 1, expected: "unmount\n", exit: 1 },
])("fails closed before deletion when mount probe=%s", async (scenario) => {
  // Given shell commands with controlled mount/probe outcomes and no real mount access.
  const root = await mkdtemp(join(tmpdir(), "perf-overlay-"));
  const log = join(root, "calls");
  await writeFile(log, "");
  for (const [name, body] of Object.entries({
    mountpoint: `exit ${scenario.mountpoint}`,
    umount: `printf 'unmount\\n' >> "$CALLS"; exit ${scenario.unmount}`,
    rm: 'printf "delete\\n" >> "$CALLS"',
  })) {
    await writeFile(join(root, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(root, name), 0o700);
  }
  try {
    // When the actual storage cleanup shell fragment runs against those commands.
    const child = Bun.spawn(["/bin/sh", "-ec", `${unmountPerformanceOverlay}; rm -rf -- "$1"`, "sh", root], {
      env: { PATH: root, CALLS: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await child.exited;
    // Then only a successful unmount or a confirmed absent mount permits deletion.
    expect(exit).toBe(scenario.exit);
    expect(await Bun.file(log).text()).toBe(scenario.expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
