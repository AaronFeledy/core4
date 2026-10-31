import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { writeHostProxyCredentials } from "../../../src/subsystems/host-proxy/credentials-file.ts";

const credentials = { app: "demo", session: "session-value", token: "token-value" };

test("publishes complete read-only credentials atomically inside a private directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-credentials-"));
  const directory = join(root, "session");
  const path = join(directory, "credentials");
  try {
    await Effect.runPromise(writeHostProxyCredentials(directory, credentials));
    const previous = await open(path, "r");
    try {
      await Effect.runPromise(writeHostProxyCredentials(directory, { ...credentials, token: "new-token" }));
      expect(JSON.parse(await previous.readFile("utf8"))).toEqual({ version: 1, ...credentials });
      expect(await Bun.file(path).json()).toEqual({ version: 1, ...credentials, token: "new-token" });
    } finally {
      await previous.close();
    }
    const directoryStat = await lstat(directory);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(directoryStat.uid).toBe(process.getuid?.() ?? -1);
    expect((await lstat(path)).mode & 0o777).toBe(0o444);
    expect(await readdir(directory)).toEqual(["credentials"]);
    expect(await Bun.file(path).text()).not.toContain("controlToken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["permissive", "symlink"] as const)(
  "rejects a %s session directory without altering its contents",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-credentials-privacy-"));
    const directory = join(root, "session");
    const target = join(root, "target");
    try {
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "sentinel"), "untouched");
      if (kind === "symlink") await symlink(target, directory);
      else {
        await mkdir(directory);
        await chmod(directory, 0o755);
      }
      const result = await Effect.runPromiseExit(writeHostProxyCredentials(directory, credentials));
      expect(result._tag).toBe("Failure");
      expect(await Bun.file(join(directory, "credentials")).exists()).toBe(false);
      expect(await Bun.file(join(target, "sentinel")).text()).toBe("untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "enforces and verifies directory ACLs through injected private access (deny=%s)",
  async (deny) => {
    const root = await mkdtemp(join(tmpdir(), "lando-credentials-acl-"));
    const directory = join(root, "session");
    const calls: string[] = [];
    try {
      const result = await Effect.runPromiseExit(
        writeHostProxyCredentials(directory, credentials).pipe(
          Effect.provideService(PrivateFileAccessService, {
            enforce: async (path) => {
              calls.push(`enforce:${path}`);
            },
            verify: async (path) => {
              calls.push(`verify:${path}`);
              if (deny) throw new Error("private ACL verification denied");
            },
          }),
        ),
      );
      expect(calls).toEqual([`enforce:${directory}`, `verify:${directory}`]);
      expect(result._tag).toBe(deny ? "Failure" : "Success");
      expect(await Bun.file(join(directory, "credentials")).exists()).toBe(!deny);
      expect(JSON.stringify(result)).not.toContain(credentials.token);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
