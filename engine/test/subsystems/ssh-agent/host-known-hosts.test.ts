import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
      if (kind === "file" || kind === "symlink") {
        const stats = await stat(path, { bigint: true });
        expect(result).toEqual({ path, sourceIdentity: `${stats.dev}:${stats.ino}` });
      } else {
        expect(result).toBeUndefined();
      }
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

for (const change of ["append", "replace", "retarget", "remove"] as const) {
  test(`tracks known hosts source identity across ${change}`, async () => {
    // Given a real source, optionally reached through a symlink.
    const home = await mkdtemp(join(tmpdir(), "lando-known-hosts-identity-"));
    try {
      await mkdir(join(home, ".ssh"));
      const path = join(home, ".ssh", "known_hosts");
      const original = change === "retarget" ? join(home, "original") : path;
      await writeFile(original, "host-a ssh-ed25519 fixture-a");
      if (change === "retarget") await symlink(original, path);
      const before = await Effect.runPromise(hostKnownHostsFile(home));
      // When the source changes without changing its authored path.
      switch (change) {
        case "append":
          await appendFile(path, "\nhost-b ssh-ed25519 fixture-b");
          break;
        case "replace":
          await writeFile(join(home, "replacement"), "host-c ssh-ed25519 fixture-c");
          await rename(join(home, "replacement"), path);
          break;
        case "retarget":
          await writeFile(join(home, "replacement"), "host-c ssh-ed25519 fixture-c");
          await symlink(join(home, "replacement"), join(home, "new-link"));
          await rename(join(home, "new-link"), path);
          break;
        case "remove":
          await unlink(path);
          break;
        default:
          change satisfies never;
      }
      const after = await Effect.runPromise(hostKnownHostsFile(home));
      // Then append preserves the mounted inode, replacement changes it, and absence skips it.
      if (change === "remove") expect(after).toBeUndefined();
      else if (change === "append") expect(after).toEqual(before);
      else {
        expect(after?.path).toBe(path);
        expect(after?.sourceIdentity).not.toBe(before?.sourceIdentity);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
