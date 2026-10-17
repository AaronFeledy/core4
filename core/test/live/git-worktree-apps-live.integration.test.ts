import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";

import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const timeout = 300_000;
const failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({
    _tag: Schema.String,
    status: Schema.optional(Schema.String),
  }),
});

const run = async (cwd: string, argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], {
    cwd,
    // Keep the managed socket and runtime installation in the inherited roots,
    // just like scanner-live-fixture; only these uniquely named apps are changed.
    env: { ...process.env, GIT_MASTER: "1", LANDO_TELEMETRY_ENABLED: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  console.log("WORKTREE_CLI", JSON.stringify({ cwd, argv, exitCode, stdout, stderr }));
  return { exitCode, stdout, stderr };
};

const cli = (cwd: string, args: readonly string[]) => run(cwd, [process.execPath, cliEntry, ...args]);
const succeeds = async (cwd: string, args: readonly string[]) => {
  const result = await cli(cwd, args);
  expect(result.exitCode, JSON.stringify({ cwd, args, ...result })).toBe(0);
  return result.stdout;
};

const fails = async (cwd: string, args: readonly string[]) => {
  const result = await cli(cwd, [...args, "--format=json"]);
  expect(result.exitCode, JSON.stringify({ cwd, args, ...result })).not.toBe(0);
  return Schema.decodeUnknownSync(Schema.fromJsonString(failure))(result.stdout).error;
};

const exec = async (cwd: string, command: string) => {
  const output = await succeeds(cwd, ["exec", "web", "--format=json", "--", "sh", "-c", command]);
  const lines = output.split("\n");
  const result = lines.find((line) => line.startsWith('{"_tag":"result"'));
  Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ envelope: Schema.Struct({ ok: Schema.Literal(true) }) })),
  )(result);
  return lines
    .filter((line) => line.startsWith('{"_tag":"stdout"'))
    .map(
      (line) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ chunk: Schema.String })))(line).chunk,
    )
    .join("");
};

describe.serial("live git-worktree apps", () => {
  test.skipIf(!liveEnabled)(
    "preserves Git mounts and SQL data across worktree seeding and volume generations",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given: two isolated checkouts sharing one Git repository.
            const root = yield* Effect.acquireRelease(
              Effect.promise(() => mkdtemp(join(tmpdir(), "lando-worktree-live-"))),
              (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
            );
            const shop = join(root, "shop");
            const feature = join(root, "shop-feature");
            const suffix = crypto.randomUUID().slice(0, 8);
            const name = `shop-${suffix}`;
            yield* Effect.promise(async () => {
              await mkdir(shop);
              await Bun.write(
                join(shop, ".lando.yml"),
                `name: ${name}\nruntime: 4\nprovider: lando\nrouter:\n  enabled: false\nservices:\n  web:\n    type: node:22\n    primary: true\n  database:\n    type: postgres\n`,
              );
              await Bun.write(join(shop, ".gitignore"), ".lando.local.yml\n");
              for (const args of [
                ["init"],
                ["add", ".lando.yml", ".gitignore"],
                [
                  "-c",
                  "user.name=Lando Live",
                  "-c",
                  "user.email=live@example.invalid",
                  "commit",
                  "-m",
                  "initial shop",
                ],
                ["worktree", "add", "../shop-feature", "-b", "feature"],
              ]) {
                const result = await run(shop, ["git", ...args]);
                expect(result.exitCode, result.stderr).toBe(0);
              }
              await Bun.write(join(feature, ".lando.local.yml"), `name: shop-feature-${suffix}\n`);
            });
            for (const cwd of [shop, feature]) {
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => succeeds(cwd, ["destroy", "-y", "--volumes", "--format=json"])),
              );
            }

            // When: the real CLI starts the main checkout and creates source data.
            yield* Effect.promise(() => succeeds(shop, ["start", "--format=json"]));
            yield* Effect.promise(() =>
              succeeds(shop, [
                "psql",
                "-c",
                "CREATE TABLE products (id int); INSERT INTO products VALUES (1),(2),(3);",
              ]),
            );

            // Then: the main checkout exposes its real Git directory, not an overlay.
            const mainGit = yield* Effect.promise(() =>
              exec(
                shop,
                "test -d /app/.git && ls /app/.git && git -C /app rev-parse HEAD && cat /proc/self/mountinfo",
              ),
            );
            expect(mainGit).toContain("HEAD");
            expect(mainGit).not.toContain("-app-git-");

            yield* Effect.promise(() => succeeds(feature, ["start", "--format=json"]));
            const worktreeGit = yield* Effect.promise(() =>
              exec(
                feature,
                "cat /app/.git && git -C /app status --short && git -C /app log --oneline -1 && cat /proc/self/mountinfo",
              ),
            );
            expect(worktreeGit.trimStart().startsWith("gitdir:")).toBe(true);
            expect(worktreeGit).toContain("initial shop");
            const mounts = worktreeGit.split("\n").map((line) => line.split(" "));
            expect(
              mounts.some((fields) => fields[3] === join(shop, ".git") && fields[4] === join(shop, ".git")),
            ).toBe(true);
            expect(
              mounts.some(
                (fields) => fields[4] === "/app/node_modules" && fields[3]?.includes("/volumes/") === true,
              ),
            ).toBe(true);

            yield* Effect.promise(() => succeeds(feature, ["db:seed", "--from-app", name, "--format=json"]));
            expect(
              (yield* Effect.promise(() =>
                succeeds(feature, ["psql", "-tAc", "SELECT count(*) FROM products;"]),
              )).trim(),
            ).toBe("3");
            expect(
              yield* Effect.promise(() => fails(feature, ["db:seed", "--from-app", name])),
            ).toMatchObject({ _tag: "SqlSeedStateError", status: "seeded" });

            yield* Effect.promise(() =>
              succeeds(feature, ["db:snapshot", "--label", "seeded", "--format=json"]),
            );
            yield* Effect.promise(() => succeeds(feature, ["destroy", "-y", "--volumes", "--format=json"]));
            yield* Effect.promise(() => succeeds(feature, ["start", "--format=json"]));
            yield* Effect.promise(() =>
              succeeds(feature, ["db:seed", "--snapshot", "seeded", "--format=json"]),
            );
            expect(
              (yield* Effect.promise(() =>
                succeeds(feature, ["psql", "-tAc", "SELECT count(*) FROM products;"]),
              )).trim(),
            ).toBe("3");

            // Restore must use a snapshot from the current volume generation.
            yield* Effect.promise(() =>
              succeeds(feature, ["db:snapshot", "--label", "before-drop", "--format=json"]),
            );
            yield* Effect.promise(() => succeeds(feature, ["psql", "-c", "DROP TABLE products;"]));
            yield* Effect.promise(() =>
              succeeds(feature, ["db:restore", "before-drop", "--yes", "--format=json"]),
            );
            expect(
              (yield* Effect.promise(() =>
                succeeds(feature, ["psql", "-tAc", "SELECT count(*) FROM products;"]),
              )).trim(),
            ).toBe("3");
            expect(
              yield* Effect.promise(() => fails(feature, ["db:seed", "--from-app", "nope"])),
            ).toMatchObject({ _tag: "SqlSeedSourceError" });
            expect(
              yield* Effect.promise(() => fails(feature, ["db:restore", "nope", "--yes"])),
            ).toMatchObject({ _tag: "SnapshotNotFoundError" });
          }),
        ),
      );
    },
    1_800_000,
  );
});
