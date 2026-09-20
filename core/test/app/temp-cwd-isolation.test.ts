import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

const roots: string[] = [];

const makeRoot = async (label: string): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `lando-cwd-${label}-`)));
  roots.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Gate {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

const gate = (): Gate => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

describe("withCwd", () => {
  test("restores the process cwd once the body completes", async () => {
    const before = process.cwd();
    const root = await makeRoot("restore");

    const inside = await withCwd(root, async () => process.cwd());

    expect(inside).toBe(root);
    expect(process.cwd()).toBe(before);
  });

  test("returns to the anchor when a call exits while an outlived call remains", async () => {
    const before = process.cwd();
    const abandoned = await makeRoot("abandoned-anchor");
    const follower = await makeRoot("follower-anchor");
    const held = gate();

    const outlived = withCwd(abandoned, () => held.reached);
    await withCwd(follower, async () => undefined);
    const afterFollower = process.cwd();
    held.release();
    await outlived;

    expect(afterFollower).toBe(before);
  });

  // Bun does not cancel the body of a test that exceeds its time budget: it
  // records the failure and starts the next test while that body keeps
  // running. Its teardown therefore lands in the middle of a later test. The
  // two tests below pin that interleaving, which is what turned a single slow
  // test in core/test/app/resolve.test.ts into a whole-file cascade.
  test("a call that outlives its test leaves the following test in its own directory", async () => {
    const abandoned = await makeRoot("abandoned");
    const follower = await makeRoot("follower");
    const held = gate();

    const outlived = withCwd(abandoned, () => held.reached);

    const observed = await withCwd(follower, async () => {
      held.release();
      await outlived;
      return process.cwd();
    });

    expect(observed).toBe(follower);
  });

  test("a temp root removed by an outlived call is never a later call's restore target", async () => {
    const abandoned = await makeRoot("abandoned-removed");
    const follower = await makeRoot("follower-removed");
    const abandonedGate = gate();
    const followerGate = gate();

    const outlived = withCwd(abandoned, () => abandonedGate.reached);
    // The follower enters while the outlived call is still standing in its own
    // temp root, so the ambient cwd is a directory that is about to be removed.
    const following = withCwd(follower, () => followerGate.reached);

    abandonedGate.release();
    await outlived;
    await rm(abandoned, { recursive: true, force: true });

    followerGate.release();
    const settled = await following.then(
      () => "restored" as const,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );

    expect(settled).toBe("restored");
    expect(existsSync(process.cwd())).toBe(true);
  });

  test("an outlived call that re-enters its own root does not strand the live test there", async () => {
    const abandoned = await makeRoot("abandoned-reentered");
    const follower = await makeRoot("follower-reentered");
    const held = gate();

    // Mirrors the mid-test `Effect.ensuring(() => process.chdir(left))` calls
    // in resolve.test.ts: an outlived body puts the cwd back inside its own
    // root on the way out, long after a later test took the cwd. Its caller
    // then removes that root.
    const outlived = withCwd(abandoned, async () => {
      await held.reached;
      process.chdir(abandoned);
    });

    const observed = await withCwd(follower, async () => {
      held.release();
      await outlived;
      await rm(abandoned, { recursive: true, force: true });
      return process.cwd();
    });

    expect(observed).toBe(follower);
  });
});

describe("withEnvVar", () => {
  const name = "LANDO_USER_CACHE_ROOT";

  test("restores the captured env value once the body completes", async () => {
    const before = process.env[name];
    const observed = await withEnvVar(name, "/tmp/lando-env-restore", async () => process.env[name]);

    expect(observed).toBe("/tmp/lando-env-restore");
    expect(process.env[name]).toBe(before);
  });

  test("a later owner keeps its value when an outlived call restores", async () => {
    const held = gate();
    const outlived = withEnvVar(name, "/tmp/lando-env-abandoned", () => held.reached);
    const observed = await withEnvVar(name, "/tmp/lando-env-follower", async () => {
      held.release();
      await outlived;
      return process.env[name];
    });

    expect(observed).toBe("/tmp/lando-env-follower");
  });

  test("a later owner hands the env back to an outlived call rather than the host default", async () => {
    const before = process.env[name];
    const held = gate();
    const outlived = withEnvVar(name, "/tmp/lando-env-abandoned-keep", () => held.reached);
    await withEnvVar(name, "/tmp/lando-env-follower-keep", async () => undefined);
    const afterFollower = process.env[name];
    held.release();
    await outlived;

    expect(afterFollower).toBe("/tmp/lando-env-abandoned-keep");
    expect(process.env[name]).toBe(before);
  });

  test("an outlived call does not restore the ambient value a later call captured on entry", async () => {
    const before = process.env[name];
    const abandonedGate = gate();
    const followerGate = gate();

    const outlived = withEnvVar(name, "/tmp/lando-env-abandoned-ambient", () => abandonedGate.reached);
    const following = withEnvVar(name, "/tmp/lando-env-follower-ambient", () => followerGate.reached);

    abandonedGate.release();
    await outlived;
    expect(process.env[name]).toBe("/tmp/lando-env-follower-ambient");

    followerGate.release();
    await following;
    expect(process.env[name]).toBe(before);
  });

  test("restores an unset variable by deleting it instead of storing the string undefined", async () => {
    const before = process.env[name];
    delete process.env[name];
    try {
      await withEnvVar(name, "/tmp/lando-env-was-unset", async () => undefined);
      expect(name in process.env).toBe(false);
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  });
});
