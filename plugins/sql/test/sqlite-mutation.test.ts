import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeLandoPaths } from "@lando/paths";
import {
  SqlCommandFailedError,
  SqlRecoveryOperationError,
  SqlRecoveryUnavailableError,
  StateStoreError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, ServiceName, planAppIdentity } from "@lando/sdk/schema";
import { type EphemeralRunSpec, StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Cause, Effect, Exit, Option } from "effect";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { sqliteMutationPrelude } from "../src/sqlite-mutation-control.ts";
import { mutateSqlite } from "../src/sqlite-mutation.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);
const fixture = async (
  mode:
    | "success"
    | "missing"
    | "catalog-failure"
    | "command-failure"
    | "resume-failure"
    | "suspend-failure"
    | "readiness-failure",
) => {
  const f = await makeRetentionTestDeps();
  const paths = makeLandoPaths({
    userConfRoot: join(f.harness.root, "conf"),
    userDataRoot: join(f.harness.root, "data"),
    userCacheRoot: join(f.harness.root, "cache"),
    env: {},
  });
  const disk = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
  const stateStore =
    mode === "catalog-failure"
      ? {
          ...disk,
          open: () =>
            Effect.fail(
              new StateStoreError({
                reason: "io",
                operation: "open",
                cause: "catalog failure",
                remediation: "Retry.",
              }),
            ),
        }
      : disk;
  const identity = planAppIdentity({ root: AbsolutePath.make(f.harness.root) });
  const applied = { root: identity.appRoot, identity };
  const target = {
    kind: "file",
    name: "appserver",
    type: "php:8.3",
    family: "sqlite",
    path: "data/site.sqlite",
  } as const;
  const transitions: string[] = [];
  let running = true;
  const inspect = () =>
    Effect.succeed({
      status: running ? ("running" as const) : ("stopped" as const),
      running,
      containerId: "exact-container",
      imageIdentity: "exact-image",
    });
  const run = (spec: EphemeralRunSpec) =>
    Effect.tryPromise({
      try: async () => {
        if (spec.command.includes("sqlite-owner"))
          return { exitCode: 0, stdout: `${mode === "missing" ? "missing\n" : ""}100:200\n`, stderr: "" };
        if (spec.stdinStream === undefined) return { exitCode: 0, stdout: "ok\n", stderr: "" };
        const scratch = spec.binds?.[0];
        if (scratch === undefined) throw new Error("Missing scratch bind");
        const hostPath = (targetPath: string) =>
          join(scratch.source, targetPath.slice(scratch.target.length));
        let iteration = 0;
        for await (const chunk of spec.stdinStream) {
          const sql = new TextDecoder().decode(chunk);
          const outputs = [...sql.matchAll(/^\.output (".*")$/gmu)].map((match) => {
            const path: unknown = JSON.parse(match[1] ?? "null");
            if (typeof path !== "string") throw new Error("Invalid output path");
            return hostPath(path);
          });
          if (iteration++ === 0) {
            const backupText = /^\.backup main (".*")$/mu.exec(sql)?.[1];
            if (backupText !== undefined) {
              const backup: unknown = JSON.parse(backupText);
              if (typeof backup !== "string") throw new Error("Invalid backup path");
              await writeFile(hostPath(backup), "SQLite format 3\0captured recovery");
            }
            const [version, ready] = outputs;
            if (version === undefined || ready === undefined) throw new Error("Missing capture handshake");
            await writeFile(version, "3.45.0\n");
            await writeFile(ready, "ready\n");
          } else {
            if (mode === "command-failure")
              throw new VolumeOperationError({
                providerId: "test",
                operation: "run.remove",
                message: "Cleanup also failed.",
                remediation: "Retry.",
                details: { exitCode: 7, stderrTail: "primary sqlite failure" },
              });
            const id = /SELECT '([a-z0-9-]+)' FROM temp.lando_integrity_count/u.exec(sql)?.[1];
            const receipt = outputs.at(-1);
            if (id === undefined || receipt === undefined) throw new Error("Missing mutation receipt");
            await writeFile(receipt, id);
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      catch: (cause) => cause,
    });
  const deps = {
    ...f.deps,
    inspect,
    waitForReady: () =>
      mode === "readiness-failure" ? Effect.fail("service readiness failed") : Effect.void,
    plan: {
      ...f.deps.plan,
      services: {
        appserver: {
          name: target.name,
          type: target.type,
          sqlite: { path: target.path },
          environment: {},
          extensions: {},
          storage: [],
          mounts: [
            {
              type: "bind" as const,
              source: f.harness.root,
              target: "/app",
              role: "app" as const,
              readOnly: false,
              realization: "accelerated" as const,
            },
          ],
        },
      },
    },
    suspend: (_service: string, expected: { readonly containerId: string; readonly imageIdentity: string }) =>
      Effect.sync(() => {
        expect(expected).toEqual({ containerId: "exact-container", imageIdentity: "exact-image" });
        transitions.push("suspend");
        running = false;
      }).pipe(
        Effect.andThen(
          mode === "suspend-failure" ? Effect.fail("suspend failed after stopping") : Effect.void,
        ),
      ),
    resume: (_service: string, expected: { readonly containerId: string; readonly imageIdentity: string }) =>
      Effect.sync(() => {
        expect(expected).toEqual({ containerId: "exact-container", imageIdentity: "exact-image" });
        transitions.push("resume");
        running = true;
      }).pipe(
        Effect.andThen(
          mode === "resume-failure" || mode === "command-failure"
            ? Effect.fail("resume failed")
            : Effect.void,
        ),
      ),
    sqlite: {
      applied,
      paths,
      stateStore,
      inspect,
      privateFileAccess: f.deps.privateFileAccess,
      run,
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
    },
  };
  const snapshots = () =>
    Effect.runPromise(
      f.mover.listSnapshots({
        app: AppId.make(f.deps.plan.id),
        store: sqliteSnapshotStore(target.path),
        service: ServiceName.make(target.name),
      }),
    );
  return { deps, target, transitions, snapshots, published: f.harness.published };
};

test("SQLite retains a 5000 ms busy timeout while holding one EXCLUSIVE connection", () => {
  const prelude = sqliteMutationPrelude("/scratch/backup", "/scratch/version", "/scratch/ready");
  expect(prelude).toContain(".timeout 5000");
  expect(prelude).toMatch(/BEGIN EXCLUSIVE[\s\S]*\.backup main/u);
});

test("SQLite mutations suspend the exact running container and resume after catalogued recovery", async () => {
  const f = await fixture("success");
  const result = await Effect.runPromise(
    executeSqliteCommand(f.deps, { action: "reset", yes: true }, f.target),
  );
  expect(f.transitions).toEqual(["suspend", "resume"]);
  const [snapshot] = await f.snapshots();
  expect(result.recoverySnapshotId).toBe(snapshot?.id);
  expect(snapshot?.metadata).toEqual({
    service: ServiceName.make("appserver"),
    family: "sqlite",
    path: f.target.path,
    version: "3.45.0",
    recoveryReason: "reset",
  });
});

test("SQLite initializes missing targets without advertising a recovery snapshot", async () => {
  const f = await fixture("missing");
  const result = await Effect.runPromise(
    executeSqliteCommand(f.deps, { action: "reset", yes: true }, f.target),
  );
  expect(result.recoverySkipped).toBe("database-missing");
  expect(result.recoverySnapshotId).toBeUndefined();
  expect(await f.snapshots()).toEqual([]);
  expect(f.transitions).toEqual(["suspend", "resume"]);
});

test("SQLite removes prepared inputs when failure precedes recovery capture", async () => {
  const f = await fixture("success");
  const service = f.deps.plan.services.appserver;
  let input = "";
  const exit = await Effect.runPromiseExit(
    mutateSqlite(f.deps, f.deps.sqlite, service, f.target, "import", (helper) => {
      input = join(helper.scratchHost, "private-input.sql");
      return Effect.promise(() => writeFile(input, "private input")).pipe(
        Effect.andThen(Effect.fail("preparation failed")),
      );
    }),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(await Bun.file(input).exists()).toBe(false);
});

for (const mode of [
  "command-failure",
  "resume-failure",
  "catalog-failure",
  "suspend-failure",
  "readiness-failure",
] as const) {
  test(`SQLite resumes after ${mode} and preserves the correct recovery evidence`, async () => {
    const f = await fixture(mode);
    const exit = await Effect.runPromiseExit(
      executeSqliteCommand(f.deps, { action: "reset", yes: true }, f.target),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected mutation failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(f.transitions).toEqual(["suspend", "resume"]);
    if (mode === "command-failure") {
      expect(error).toBeInstanceOf(SqlCommandFailedError);
      expect(error).toMatchObject({ exitCode: 7, stderrTail: "primary sqlite failure" });
      expect(error).toHaveProperty("recoverySnapshotId");
      // Resume also fails here; the user is warned the service stayed stopped.
      expect(f.published()).toContain("message.warn");
    } else if (mode === "resume-failure" || mode === "readiness-failure") {
      expect(error).toBeInstanceOf(SqlRecoveryOperationError);
      expect(error).toHaveProperty("recoverySnapshotId");
    } else if (mode === "catalog-failure") {
      expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
      expect(error).not.toHaveProperty("recoverySnapshotId");
      if (!(error instanceof SqlRecoveryUnavailableError)) throw new Error("Expected retained file error");
      expect(error.remediation).toContain("Recovery was captured but not catalogued");
      const path = error.recoveryFile;
      if (path === undefined) throw new Error("Missing retained recovery file path");
      expect(path.endsWith(".tar")).toBe(true);
      expect(await Bun.file(path).exists()).toBe(true);
    } else expect(error).toBe("suspend failed after stopping");
  });
}
