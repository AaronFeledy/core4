import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { SqlCommandFailedError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  ProviderId,
  type SnapshotInfo,
  planAppIdentity,
} from "@lando/sdk/schema";
import type { EphemeralRunSpec, StateStoreShape } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";

import type { SqlCommandDeps } from "../src/command-types.ts";
import { packSqliteTarFile } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import { sqliteIntegritySql } from "../src/sqlite-integrity.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
const dockerEnv =
  socket === undefined
    ? process.env
    : {
        ...process.env,
        DOCKER_HOST: socket.startsWith("unix://") ? socket : `unix://${socket}`,
      };

const docker = async (args: readonly string[], input?: AsyncIterable<Uint8Array>) => {
  const process = Bun.spawn(["docker", ...args], {
    env: dockerEnv,
    stdin:
      input === undefined
        ? "ignore"
        : new ReadableStream<Uint8Array>({
            async start(controller) {
              for await (const chunk of input) controller.enqueue(chunk);
              controller.close();
            },
          }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const expectIntegrityFailure = (failure: unknown) => {
  if (failure instanceof SqlCommandFailedError) {
    expect(failure.command.at(-1)).toBe("PRAGMA main.integrity_check;");
    return;
  }
  expect(failure).toBeInstanceOf(SqlRecoveryUnavailableError);
  if (failure instanceof SqlRecoveryUnavailableError) expect(failure.message).toContain("integrity");
};

test.skipIf(socket === undefined)(
  "rejects corrupt SQLite pages before raw import or verified snapshot restore can mutate the target",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-sqlite-integrity-"));
    const harness = makeSqlTestDeps({ password: "unused", initiallyRunning: false });
    const captured: SnapshotInfo[] = [];
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const identity = planAppIdentity({ root: AbsolutePath.make(root) });
    const target = {
      kind: "file",
      name: "appserver",
      type: "php:8.3",
      family: "sqlite",
      path: "target.sqlite",
    } as const;
    const query = (file: string, sql: string) =>
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        user,
        "--entrypoint",
        "sqlite3",
        "-v",
        `${root}:/app`,
        sqliteHelperImage.ref,
        "-bail",
        `/app/${file}`,
        sql,
      ]);
    const run = (spec: EphemeralRunSpec) =>
      Effect.tryPromise({
        try: async () => {
          const args = ["run", "--rm", "--network", "none", "--entrypoint", ""];
          if (spec.user !== undefined) args.push("--user", spec.user);
          for (const bind of spec.binds ?? [])
            args.push("-v", `${bind.source}:${bind.target}${bind.readOnly ? ":ro" : ""}`);
          if (spec.stdinStream !== undefined) args.push("-i");
          return docker([...args, spec.image, ...spec.command], spec.stdinStream);
        },
        catch: (cause) => cause,
      });
    const stateStore = {
      withLock: <A, E>(_key: string, body: Effect.Effect<A, E>) => body,
      open: () =>
        Effect.succeed({
          set: (info: SnapshotInfo) =>
            Effect.sync(() => {
              captured.push(info);
            }),
        }),
    } as unknown as StateStoreShape;
    const applied = {
      id: "integrity-app",
      root: AbsolutePath.make(root),
      identity,
      provider: ProviderId.make("docker"),
    } as AppPlan;
    const ownerSnapshotsDir = () => join(root, "snapshots");
    let restoreInfo: SnapshotInfo | undefined;
    const deps: SqlCommandDeps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        id: "integrity-app",
        root,
        identity,
        services: {
          appserver: {
            name: "appserver",
            type: "php:8.3",
            environment: {},
            sqlite: { path: target.path },
            storage: [],
            mounts: [
              {
                type: "bind",
                source: root,
                target: "/app",
                readOnly: false,
                role: "app",
                realization: "passthrough",
              },
            ],
          },
        },
      },
      sqlite: {
        applied,
        run,
        pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
        paths: { ownerSnapshotsDir },
        stateStore,
      },
      resolveSnapshot: () =>
        restoreInfo === undefined ? Effect.die("missing test snapshot") : Effect.succeed(restoreInfo),
    };
    try {
      const pull = await docker(["pull", sqliteHelperImage.ref]);
      expect(pull.exitCode).toBe(0);
      expect(
        (
          await query(
            target.path,
            "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep target');",
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await query(
            "source.sqlite",
            "PRAGMA page_size=512; VACUUM; CREATE TABLE broken(value TEXT); INSERT INTO broken VALUES('source');",
          )
        ).exitCode,
      ).toBe(0);
      const rootPage = Number(
        (
          await query("source.sqlite", "SELECT rootpage FROM sqlite_schema WHERE name='broken';")
        ).stdout.trim(),
      );
      expect(rootPage).toBeGreaterThan(1);
      const source = await readFile(join(root, "source.sqlite"));
      const pageSize = source.readUInt16BE(16);
      source[(rootPage - 1) * pageSize] = 0;
      expect(isSqliteDatabaseHeader(source)).toBe(true);
      await writeFile(join(root, "source.sqlite"), source);
      expect((await query("source.sqlite", "SELECT * FROM broken;")).exitCode).not.toBe(0);
      expect((await query("source.sqlite", '.backup main "/app/copied.sqlite"')).exitCode).toBe(0);
      expect((await query("copied.sqlite", "SELECT 'a fixed receipt still succeeds';")).exitCode).toBe(0);
      expect((await query("copied.sqlite", "SELECT * FROM broken;")).exitCode).not.toBe(0);
      const invalidReceipt = await query(
        "source.sqlite",
        `${sqliteIntegritySql}\nSELECT 'must-not-report-success';`,
      );
      expect(invalidReceipt.exitCode).not.toBe(0);
      expect(invalidReceipt.stdout).not.toContain("must-not-report-success");
      const validReceipt = await query(target.path, `${sqliteIntegritySql}\nSELECT 'integrity-passed';`);
      expect(validReceipt.exitCode).toBe(0);
      expect(validReceipt.stdout.trim()).toBe("integrity-passed");

      const imported = await Effect.runPromiseExit(
        executeSqliteCommand(
          deps,
          { action: "import", yes: true, file: join(root, "source.sqlite") },
          target,
        ),
      );
      expect(Exit.isFailure(imported)).toBe(true);
      expect(captured).toHaveLength(0);
      expect((await query(target.path, "SELECT value FROM sentinel;")).stdout.trim()).toBe("keep target");
      if (Exit.isFailure(imported)) {
        const failure = Option.getOrUndefined(Cause.findErrorOption(imported.cause));
        expectIntegrityFailure(failure);
        expect(Reflect.get(failure as object, "recoverySnapshotId")).toBeUndefined();
      }

      await Effect.runPromise(executeSqliteCommand(deps, { action: "snapshot", yes: true }, target));
      expect(captured).toHaveLength(1);
      const snapshot = captured[0];
      if (snapshot === undefined) throw new Error("Expected captured snapshot");
      const archive = join(ownerSnapshotsDir(), snapshot.store.store, `${snapshot.id}.tar`);
      const packed = await packSqliteTarFile(join(root, "source.sqlite"), archive);
      // Matching archive digest/size must not make physically corrupt SQLite pages valid.
      restoreInfo = { ...snapshot, digest: packed.digest, sizeBytes: packed.sizeBytes };
      const restored = await Effect.runPromiseExit(
        executeSqliteCommand(deps, { action: "restore", yes: true, snapshotId: snapshot.id }, target),
      );
      expect(Exit.isFailure(restored)).toBe(true);
      if (Exit.isFailure(restored)) {
        expectIntegrityFailure(Option.getOrUndefined(Cause.findErrorOption(restored.cause)));
      }
      expect(captured).toHaveLength(1);
      expect((await query(target.path, "SELECT value FROM sentinel;")).stdout.trim()).toBe("keep target");

      await writeFile(join(root, target.path), source);
      const beforeReset = await readFile(join(root, target.path));
      const reset = await Effect.runPromiseExit(
        executeSqliteCommand(deps, { action: "reset", yes: true }, target),
      );
      expect(Exit.isFailure(reset)).toBe(true);
      if (Exit.isFailure(reset)) {
        const failure = Option.getOrUndefined(Cause.findErrorOption(reset.cause));
        expectIntegrityFailure(failure);
        expect(Reflect.get(failure as object, "recoverySnapshotId")).toBeUndefined();
      }
      expect(captured).toHaveLength(1);
      expect([...(await readFile(join(root, target.path)))]).toEqual([...beforeReset]);
    } finally {
      cleanupSqlTestDeps();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
