import { afterEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { SqlSeedSourceError } from "@lando/sdk/errors";

import { executeDbCommand } from "../src/run.ts";
import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import { coveringSqliteMount, sqliteContainerPath } from "../src/sqlite-mount.ts";
import { sqliteSidecarPaths, sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteSnapshotsCompatible } from "../src/sqlite-snapshot.ts";
import { overlaySqliteFromLandofile } from "../src/views.ts";
import type { SqlPlanService } from "../src/views.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const header = new TextEncoder().encode("SQLite format 3\0more");

describe("sqlite header detection", () => {
  test("accepts the 16-byte SQLite format 3 header", () => {
    expect(isSqliteDatabaseHeader(header)).toBe(true);
    expect(isSqliteDatabaseHeader(new TextEncoder().encode("SQLite format 3"))).toBe(false);
    expect(isSqliteDatabaseHeader(new TextEncoder().encode("CREATE TABLE t (id int);"))).toBe(false);
  });
});

describe("sqlite sidecars and store names", () => {
  test("names wal, shm, and journal sidecars next to the database path", () => {
    expect(sqliteSidecarPaths("/app/data/site.sqlite")).toEqual([
      "/app/data/site.sqlite-wal",
      "/app/data/site.sqlite-shm",
      "/app/data/site.sqlite-journal",
    ]);
  });

  test("hashes the relative path into a hex-only snapshot store name", () => {
    const store = sqliteSnapshotStore("data/site.sqlite");
    expect(store.startsWith("sqlite-")).toBe(true);
    expect(store).toMatch(/^sqlite-[0-9a-f]{32}$/u);
    expect(sqliteSnapshotStore("data/other.sqlite")).not.toBe(store);
  });
});

describe("covering sqlite mounts", () => {
  const service = (mounts: SqlPlanService["mounts"]): SqlPlanService => ({
    name: "appserver",
    type: "php:8.3",
    environment: {},
    mounts,
    storage: [],
  });
  const target = {
    kind: "file" as const,
    name: "appserver",
    type: "php:8.3",
    family: "sqlite" as const,
    path: "data/site.sqlite",
  };

  test("joins sqlite.path onto the app mount", () => {
    expect(
      sqliteContainerPath(
        service([{ type: "bind", source: "/host/app", target: "/app", readOnly: false, role: "app" }]),
        target,
      ),
    ).toBe("/app/data/site.sqlite");
  });

  test("selects the deepest exclude volume over the parent app bind", () => {
    const covering = coveringSqliteMount(
      service([
        { type: "bind", source: "/host/app", target: "/app", readOnly: false, role: "app" },
        { type: "volume", store: "appserver_data", target: "/app/data", readOnly: false },
      ]),
      "/app/data/site.sqlite",
    );
    expect(covering).toEqual({
      kind: "volume",
      store: "appserver_data",
      target: "/app/data",
      readOnly: false,
    });
  });

  test("rejects tmpfs covering mounts", () => {
    expect(
      coveringSqliteMount(service([{ type: "tmpfs", target: "/app/data" }]), "/app/data/site.sqlite"),
    ).toEqual({ kind: "tmpfs", target: "/app/data" });
  });
});

describe("sqlite snapshot compatibility", () => {
  test("keys on sqlite_version, owner, service, and path rather than image identity", () => {
    const source = {
      owner: { appRoot: "/app", ownerKey: "abc" },
      id: "snap",
      store: { app: "app", store: "sqlite-deadbeef" },
      digest: "d".repeat(64),
      sizeBytes: 1,
      createdAt: "2026-01-01T00:00:00.000Z" as never,
      metadata: {
        service: "appserver",
        volumeInstanceId: "data/site.sqlite",
        family: "sqlite",
        version: "3.54.1",
        imageIdentity: "ignored-image",
        recoveryReason: "manual" as const,
      },
    };
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        service: "appserver",
        path: "data/site.sqlite",
        version: "3.54.1",
      }),
    ).toBe(true);
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        service: "appserver",
        path: "data/site.sqlite",
        version: "3.45.0",
      }),
    ).toBe(false);
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        service: "appserver",
        path: "other.sqlite",
        version: "3.54.1",
      }),
    ).toBe(false);
  });
});

describe("sqlite archive packing", () => {
  test("round-trips a SQLite payload through a single-file tar", () => {
    const packed = packSqliteTar(header);
    const unpacked = unpackSqliteTar(packed);
    expect(unpacked).toEqual(header);
    expect(isSqliteDatabaseHeader(unpacked ?? new Uint8Array())).toBe(true);
  });
});

describe("landofile sqlite overlay", () => {
  test("copies authored sqlite onto an applied plan service before rebuild", () => {
    const overlaid = overlaySqliteFromLandofile(
      {
        id: "app",
        name: "app",
        root: "/app",
        services: {
          appserver: {
            name: "appserver",
            type: "php:8.3",
            environment: {},
            mounts: [],
            storage: [],
          },
        },
      },
      { services: { appserver: { type: "php:8.3", sqlite: { path: "data/site.sqlite" } } } },
    );
    expect(overlaid.services.appserver?.sqlite).toEqual({ path: "data/site.sqlite" });
  });
});

describe("sqlite seed", () => {
  afterEach(cleanupSqlTestDeps);

  test("fails closed because seed is volume initialization, not a file target", async () => {
    const harness = makeSqlTestDeps({ password: "secret" });
    const database = harness.deps.plan.services.database;
    if (database === undefined) throw new Error("expected database service");
    const deps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        services: {
          ...harness.deps.plan.services,
          database: { ...database, sqlite: { path: "data/site.sqlite" } },
        },
      },
    };
    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, {
        action: "seed",
        yes: true,
        file: "dump.sql",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlSeedSourceError);
    if (!(error instanceof SqlSeedSourceError)) return;
    expect(error.sourceFamily).toBe("sqlite");
    expect(error.message).toContain("not supported");
  });
});
