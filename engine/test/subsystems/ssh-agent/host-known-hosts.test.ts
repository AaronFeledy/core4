import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { hostKnownHostsFile } from "../../../src/subsystems/ssh-agent/host-known-hosts.ts";

for (const kind of ["file", "missing", "directory", "symlink"] as const) {
  test(`discovers known hosts when the host path is ${kind}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "lando-known-hosts-"));
    try {
      const path = join(home, ".ssh", "known_hosts");
      await mkdir(join(home, ".ssh"));
      switch (kind) {
        case "file":
          await writeFile(path, "host ssh-ed25519 fixture");
          break;
        case "directory":
          await mkdir(path);
          break;
        case "symlink":
          await writeFile(join(home, "trusted-hosts"), "host ssh-ed25519 fixture");
          await symlink(join(home, "trusted-hosts"), path);
          break;
        case "missing":
          break;
        default:
          kind satisfies never;
      }
      const result = await Effect.runPromise(hostKnownHostsFile(home));
      expect(result).toBe(kind === "file" || kind === "symlink" ? path : undefined);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("treats inaccessible known hosts as absent", async () => {
  const result = await Effect.runPromise(
    hostKnownHostsFile("/home/user", () =>
      Promise.reject(Object.assign(new Error("access denied"), { code: "EACCES" })),
    ),
  );
  expect(result).toBeUndefined();
});
