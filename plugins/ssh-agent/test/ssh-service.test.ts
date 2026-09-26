import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect, Exit, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { EventService, GlobalAppService, LandofileService, PathsService, SshService } from "@lando/sdk/services";

import { makeSshService, sshService } from "../src/ssh-service.ts";
import { SSH_AGENT_UPSTREAM_FALLBACK_WARNING, SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE } from "../src/upstream.ts";

const stubGlobalApp = {
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

const setupWithRealFs = (userDataRoot: string) =>
  Effect.gen(function* () {
    const ssh = yield* SshService;
    return yield* ssh.setup({ force: false });
  }).pipe(
    Effect.provide(sshService),
    Effect.provideService(PathsService, makeLandoPaths({ platform: "linux", userDataRoot, env: {} })),
    Effect.provideService(GlobalAppService, stubGlobalApp),
  );

const paths = {
  roots: { userDataRoot: "/tmp/lando-user-data" },
} as Context.Tag.Service<typeof PathsService>;

const globalApp = (calls: string[]) =>
  ({
    ensureRunning: (services: ReadonlyArray<string>) =>
      Effect.sync(() => {
        calls.push(...services);
        return [];
      }),
  }) as unknown as Context.Tag.Service<typeof GlobalAppService>;

const landofileService = (upstream: string) =>
  ({
    discover: Effect.succeed({ name: "myapp", sshAgent: { sidecar: true, upstream } }),
  }) as unknown as Context.Tag.Service<typeof LandofileService>;

const provideSsh = (
  host: Parameters<typeof makeSshService>[0],
  calls: string[] = [],
  extras: {
    readonly events?: Context.Tag.Service<typeof EventService>;
    readonly landofile?: Context.Tag.Service<typeof LandofileService>;
  } = {},
) => {
  const base = makeSshService(host).pipe(
    Layer.provide(Layer.succeed(PathsService, paths)),
    Layer.provide(Layer.succeed(GlobalAppService, globalApp(calls))),
  );
  const extrasLayers = [
    extras.events === undefined ? undefined : Layer.succeed(EventService, extras.events),
    extras.landofile === undefined ? undefined : Layer.succeed(LandofileService, extras.landofile),
  ].filter((layer): layer is Layer.Layer<EventService | LandofileService> => layer !== undefined);
  return extrasLayers.length === 0 ? base : Layer.mergeAll(base, ...extrasLayers);
};

describe("ssh-agent SshService Live", () => {
  test("setup creates userDataRoot/ssh as mode 0700", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssh-dir-create-"));
    try {
      await Effect.runPromise(setupWithRealFs(root));
      expect((await stat(join(root, "ssh"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("setup tightens a looser ssh directory to 0700", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssh-dir-loosen-"));
    const sshDir = join(root, "ssh");
    await mkdir(sshDir, { mode: 0o755 });
    await chmod(sshDir, 0o755);
    try {
      await Effect.runPromise(setupWithRealFs(root));
      expect((await stat(sshDir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("setup leaves a tighter ssh directory unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssh-dir-tight-"));
    const sshDir = join(root, "ssh");
    await mkdir(sshDir, { mode: 0o700 });
    await chmod(sshDir, 0o600);
    try {
      await Effect.runPromise(setupWithRealFs(root));
      expect((await stat(sshDir)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("getAgentSocket always returns the Lando sidecar socket", async () => {
    const socket = await Effect.runPromise(
      Effect.flatMap(SshService, (ssh) => ssh.getAgentSocket(AppId.make("myapp"))).pipe(
        Effect.provide(
          provideSsh({
            platform: "linux",
            env: { LANDO_SSH_AGENT_UPSTREAM: "host", SSH_AUTH_SOCK: "/tmp/agent.sock" },
            isSocket: () => true,
          }),
        ),
      ),
    );
    expect(socket.socketPath).toBe("/tmp/lando-user-data/ssh/ssh-agent.sock");
  });

  test("default setup starts the sidecar without changing isolation", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      Effect.flatMap(SshService, (ssh) => ssh.setup({ force: false })).pipe(
        Effect.provide(provideSsh({ platform: "linux", env: {} }, calls)),
      ),
    );
    expect(calls).toEqual(["ssh-agent"]);
  });

  test("Windows upstream hard-fails with remediation", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(SshService, (ssh) => ssh.setup({ force: false })).pipe(
        Effect.provide(
          provideSsh({
            platform: "win32",
            env: { LANDO_SSH_AGENT_UPSTREAM: "host" },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const dumped = JSON.stringify(exit);
    expect(dumped).toContain(SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE);
    expect(dumped).toContain("Unset sshAgent.upstream");
    expect(dumped).toContain("SshError");
  });

  test("invalid upstream path hard-fails", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(SshService, (ssh) => ssh.setup({ force: false })).pipe(
        Effect.provide(
          provideSsh({
            platform: "linux",
            env: { LANDO_SSH_AGENT_UPSTREAM: "relative/agent.sock" },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("absolute Unix socket path");
  });

  test("missing upstream socket still starts the sidecar", async () => {
    const calls: string[] = [];
    const published: Array<{ readonly _tag: string; readonly body?: string }> = [];
    const events = {
      publish: (event: { readonly _tag: string; readonly body?: string }) =>
        Effect.sync(() => {
          published.push(event);
        }),
    } as unknown as Context.Tag.Service<typeof EventService>;
    await Effect.runPromise(
      Effect.flatMap(SshService, (ssh) => ssh.setup({ force: false })).pipe(
        Effect.provide(
          provideSsh(
            {
              platform: "linux",
              env: { LANDO_SSH_AGENT_UPSTREAM: "host" },
              isSocket: () => false,
            },
            calls,
            { events },
          ),
        ),
      ),
    );
    expect(calls).toEqual(["ssh-agent"]);
    expect(
      published.some(
        (event) => event._tag === "message.warn" && event.body === SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
      ),
    ).toBe(true);
  });

  test("Landofile sshAgent.upstream is authored when env and config are unset", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(SshService, (ssh) => ssh.setup({ force: false })).pipe(
        Effect.provide(
          provideSsh({ platform: "win32", env: {} }, [], { landofile: landofileService("host") }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE);
  });
});
