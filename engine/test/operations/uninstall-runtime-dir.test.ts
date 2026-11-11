import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { defaultRemoveRuntimeDir } from "../../src/operations/uninstall-runtime-dir.ts";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-purge-private-"));
  const runtimeDir = join(root, "runtime");
  const privateDir = join(root, "session", "lando-0123456789abcdef");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  mkdirSync(join(runtimeDir, "storage"));
  writeFileSync(join(runtimeDir, "bin", "podman"), "fixture");
  return {
    root,
    runtimeDir,
    privateDir,
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("purge prepares private XDG for each unshare and removes only that session directory after the runtime", async () => {
  using f = fixture();
  const foreignDir = join(f.root, "session", "lando-ffffffffffffffff");
  mkdirSync(foreignDir, { recursive: true });
  let prepared = 0;
  const targets: string[] = [];
  const paused: string[] = [];
  await defaultRemoveRuntimeDir(f.runtimeDir, {
    hostEnv: { HOME: "/home/fixture", CONTAINER_HOST: "unix:///hostile.sock", LANG: "C" },
    resolvePrivateRuntimeDir: async () => f.privateDir,
    preparePrivateRuntimeDir: async () => {
      prepared += 1;
      mkdirSync(f.privateDir, { recursive: true, mode: 0o700 });
      return f.privateDir;
    },
    terminate: async () => undefined,
    unshareRm: async (_command, args, env) => {
      expect(existsSync(f.privateDir)).toBe(true);
      expect(env?.XDG_RUNTIME_DIR).toBe(f.privateDir);
      expect(env?.HOME).toBe("/home/fixture");
      expect(env?.CONTAINER_HOST).toBeUndefined();
      const target = args.at(-1);
      if (target === undefined) throw new Error("missing unshare target");
      targets.push(target);
    },
    terminatePause: async (path) => {
      expect(existsSync(f.runtimeDir)).toBe(false);
      expect(existsSync(path)).toBe(true);
      paused.push(path);
    },
  });
  expect(prepared).toBe(2);
  expect(targets).toEqual([join(f.runtimeDir, "storage"), f.runtimeDir]);
  expect(paused).toEqual([f.privateDir]);
  expect(existsSync(f.privateDir)).toBe(false);
  expect(existsSync(foreignDir)).toBe(true);
});

test("purge refuses a managed unshare when the private runtime directory cannot be prepared", async () => {
  using f = fixture();
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: "private runtime base unavailable",
    remediation: "Restore an owner-only runtime base.",
  });
  let spawned = false;
  const error = await defaultRemoveRuntimeDir(f.runtimeDir, {
    resolvePrivateRuntimeDir: async () => undefined,
    preparePrivateRuntimeDir: async () => {
      throw failure;
    },
    terminate: async () => undefined,
    unshareRm: async () => {
      spawned = true;
    },
    terminatePause: async () => {
      throw new Error("must preserve pause when purge has not happened");
    },
  }).catch((cause: unknown) => cause);
  expect(error).toBe(failure);
  expect(spawned).toBe(false);
  expect(existsSync(f.runtimeDir)).toBe(true);
});
