import { beforeAll, describe, expect, test } from "bun:test";
import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SourceGcReportSchema } from "@lando/source-acquisition/gc";
import { Schema } from "effect";
import {
  CHANGED,
  Lock,
  ORIGINAL,
  compiledCli,
  result,
  withApp,
  withRemote,
} from "./fixtures/source-store-acceptance.ts";

const Config = Schema.Struct({
  landofile: Schema.Struct({ services: Schema.Struct({ web: Schema.Struct({ type: Schema.String }) }) }),
});
const Verify = Schema.Struct({
  ok: Schema.Boolean,
  entries: Schema.Array(Schema.Struct({ status: Schema.String })),
});

// Issue #1574: exercise the shipped executable, including bootstrap, transport, and scoped cleanup.
describe.skipIf(Bun.which("git") === null)("compiled source-store acceptance (requires git on PATH)", () => {
  beforeAll(async () => {
    await compiledCli();
  }, 180_000);

  test("a peeled tag stays pinned across upstream moves and loads offline", async () => {
    await withRemote(async ({ app, repository, commit, server, url }) => {
      await app.include(url);
      await app.run(["app:includes:update"]);
      const lockPath = join(app.appRoot, ".lando.lock.yml");
      const lockBytes = await Bun.file(lockPath).text();
      expect(Schema.decodeUnknownSync(Lock)(Bun.YAML.parse(lockBytes)).includes).toEqual([
        { source: `${url}/fragment.yml`, version: "v1", resolved: commit },
      ]);
      await repository.advance([
        { kind: "commit", message: "move branch and tag", files: { "fragment.yml": CHANGED } },
        { kind: "git", args: ["tag", "-f", "-a", "v1", "-m", "moved"] },
      ]);
      const requests = server.requests.length;
      expect(result(Config, await app.run(["app:config"])).landofile.services.web.type).toBe("php");
      expect(server.requests).toHaveLength(requests);
      await server.stop();
      expect(result(Config, await app.run(["app:config"])).landofile.services.web.type).toBe("php");
      expect(result(Verify, await app.run(["app:includes:verify"]))).toMatchObject({
        ok: true,
        entries: [{ status: "ok" }],
      });
      expect(await Bun.file(lockPath).text()).toBe(lockBytes);
    });
  }, 60_000);

  test("an unchanged floating branch update does not fetch git objects", async () => {
    await withRemote(async ({ app, server, repository, url }) => {
      await app.include(url, "main");
      await app.run(["app:includes:update"]);
      const fetches = () =>
        server.requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith("/git-upload-pack") && request.fetch,
        );
      expect(fetches()).toHaveLength(1);
      const before = server.requests.length;
      await app.run(["app:includes:update"]);
      expect(server.requests.slice(before).filter((request) => request.fetch)).toEqual([]);
      expect(server.requests.slice(before).some((request) => request.protocol === "version=2")).toBe(true);
      // Positive control: moving the ref must fetch objects and expose the new fragment.
      await repository.advance([
        { kind: "commit", message: "move main", files: { "fragment.yml": CHANGED } },
      ]);
      await app.run(["app:includes:update"]);
      expect(fetches()).toHaveLength(2);
      expect(result(Config, await app.run(["app:config"])).landofile.services.web.type).toBe("node");
    });
  }, 60_000);

  test("tampered store bytes fail integrity checks and an update repairs them", async () => {
    await withRemote(async ({ app, commit, url }) => {
      await app.include(url);
      await app.run(["app:includes:update"]);
      const fragment = join(app.store, "git", commit, "tree", "fragment.yml");
      await chmod(fragment, 0o644);
      await writeFile(fragment, CHANGED);
      const failure = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            ok: Schema.Literal(false),
            error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
          }),
        ),
      )(await app.run(["app:config"], 1));
      expect(failure.error._tag).toBe("LandofileLockMismatchError");
      expect(failure.error.message).toContain("lock mismatch");
      await app.run(["app:includes:update"]);
      expect(await Bun.file(fragment).text()).toBe(ORIGINAL);
      expect(result(Config, await app.run(["app:config"])).landofile.services.web.type).toBe("php");
    });
  }, 60_000);

  test("sources:gc protects a registered pin and prunes it after its lockfile disappears", async () => {
    await withRemote(async ({ app, commit, url }) => {
      await app.include(url);
      await app.run(["app:includes:update"]);
      const report = result(SourceGcReportSchema, await app.run(["sources:gc", "--older-than=0"]));
      expect(report.entries).toMatchObject([
        { kind: "git", id: commit, protected: true, eligible: false, outcome: "kept" },
      ]);
      const prune = ["sources:gc", "--prune", "--older-than=0", "--yes"];
      expect(result(SourceGcReportSchema, await app.run(prune)).entries).toMatchObject([
        { id: commit, protected: true, outcome: "kept" },
      ]);
      await rm(join(app.appRoot, ".lando.lock.yml"));
      const removed = result(SourceGcReportSchema, await app.run(prune));
      expect(removed.entries).toMatchObject([{ id: commit, protected: false, outcome: "removed" }]);
      expect(removed.totals.removed).toBe(1);
      expect(await Bun.file(join(app.store, "git", commit, "entry.json")).exists()).toBe(false);
    });
  }, 60_000);

  // A floating ref hangs in ls-remote; a pinned commit hangs mid-fetch with a staging directory to clean up.
  for (const [signal, expected, version, phase] of [
    ["SIGINT", 130, "main", "ref resolution"],
    ["SIGTERM", 143, "0123456789abcdef0123456789abcdef01234567", "fetch"],
  ] as const) {
    test.skipIf(process.platform === "win32")(
      `${signal} during ${phase} closes the git descendant connection and cleans the store`,
      async () => {
        await withApp(async (app) => {
          const opened = Promise.withResolvers<void>();
          const closed = Promise.withResolvers<void>();
          const sockets = new Set<Bun.Socket<undefined>>();
          let signaled = false;
          const server = Bun.listen<undefined>({
            hostname: "127.0.0.1",
            port: 0,
            socket: {
              open(socket) {
                sockets.add(socket);
                opened.resolve();
              },
              data() {
                /* Deliberately leave the Git HTTP request unanswered. */
              },
              end(socket) {
                socket.end();
              },
              close(socket) {
                sockets.delete(socket);
                if (signaled) closed.resolve();
              },
            },
          });
          await app.include(`http://127.0.0.1:${server.port}/hang.git`, version);
          const child = app.spawn(["app:includes:update"]);
          const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
            const deadline = Promise.withResolvers<never>();
            const timer = setTimeout(
              () => deadline.reject(new Error(`${signal}: timed out waiting for ${label}`)),
              10_000,
            );
            try {
              return await Promise.race([promise, deadline.promise]);
            } finally {
              clearTimeout(timer);
            }
          };
          try {
            await bounded(opened.promise, "git connection");
            const staged = (await readdir(app.store)).filter((name) => name.startsWith(".staging-"));
            expect(staged.length > 0).toBe(phase === "fetch");
            signaled = true;
            child.kill(signal);
            expect(await bounded(child.exited, "CLI exit")).toBe(expected);
            await bounded(closed.promise, "git descendant connection close");
            await bounded(output, "CLI output streams");
            expect((await readdir(app.store)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
            expect(await readdir(join(app.store, ".leases"))).toEqual([]);
          } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            for (const socket of sockets) socket.terminate();
            server.stop(true);
            await child.exited;
            await output;
          }
        });
      },
      40_000,
    );
  }
});
