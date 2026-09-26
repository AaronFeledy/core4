import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";
import { Effect } from "effect";
import { sshService } from "../src/ssh-service.ts";

const globalApp = {
  id: "global" as const,
  root: Effect.succeed(AbsolutePath.make("/unused")),
  ensureRoot: Effect.void,
  paths: Effect.succeed({
    root: AbsolutePath.make("/unused"),
    distLandofile: AbsolutePath.make("/unused"),
    userLandofile: AbsolutePath.make("/unused"),
  }),
  ensureUserLandofile: Effect.succeed({ path: AbsolutePath.make("/unused"), created: false }),
  ensureRunning: (_services: ReadonlyArray<string>) => Effect.succeed([]),
  regenerateDist: () =>
    Effect.succeed({
      path: AbsolutePath.make("/unused"),
      status: "unchanged" as const,
      serviceIds: [] as ReadonlyArray<string>,
    }),
};

const setup = (userDataRoot: string) =>
  Effect.gen(function* () {
    const ssh = yield* SshService;
    return yield* ssh.setup({ force: false });
  }).pipe(
    Effect.provide(sshService),
    Effect.provideService(PathsService, makeLandoPaths({ platform: "linux", userDataRoot, env: {} })),
    Effect.provideService(GlobalAppService, globalApp),
  );

test("setup creates userDataRoot/ssh as mode 0700", async () => {
  // Given an empty data root.
  const root = await mkdtemp(join(tmpdir(), "ssh-dir-create-"));
  try {
    // When sidecar setup runs.
    await Effect.runPromise(setup(root));
    // Then the socket directory is private to the owner.
    expect((await stat(join(root, "ssh"))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup tightens a looser ssh directory to 0700", async () => {
  // Given a directory other users can traverse.
  const root = await mkdtemp(join(tmpdir(), "ssh-dir-loosen-"));
  const sshDir = join(root, "ssh");
  await mkdir(sshDir, { mode: 0o755 });
  await chmod(sshDir, 0o755);
  try {
    // When sidecar setup runs.
    await Effect.runPromise(setup(root));
    // Then group and other permissions are removed.
    expect((await stat(sshDir)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup leaves a tighter ssh directory unchanged", async () => {
  // Given a directory with fewer owner permissions than 0700.
  const root = await mkdtemp(join(tmpdir(), "ssh-dir-tight-"));
  const sshDir = join(root, "ssh");
  await mkdir(sshDir, { mode: 0o700 });
  await chmod(sshDir, 0o600);
  try {
    // When sidecar setup runs.
    await Effect.runPromise(setup(root));
    // Then the tighter mode is preserved.
    expect((await stat(sshDir)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
