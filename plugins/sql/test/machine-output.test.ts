import { afterEach, describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit, Schema } from "effect";

import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { SqlConfirmRequiredError, SqlServiceAmbiguousError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, CommandResultEnvelope, ServiceName, SnapshotInfo } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { type DbCommandInput, dbCommandRedactionTokens, executeDbCommand } from "../src/run.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

const decodeEnvelope = (encoded: string) =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(encoded));

const successInputs: ReadonlyArray<{ readonly command: string; readonly input: DbCommandInput }> = [
  { command: "db:export", input: { action: "export", yes: false } },
  { command: "db:import", input: { action: "import", file: "dump.sql.gz", yes: true } },
  { command: "db:snapshot", input: { action: "snapshot", label: "before-change", yes: false } },
  { command: "db:snapshots", input: { action: "snapshots", yes: false } },
  { command: "db:snapshots:prune", input: { action: "prune", preview: true, yes: false } },
  { command: "db:restore", input: { action: "restore", snapshotId: "before-change", yes: true } },
  { command: "db:reset", input: { action: "reset", yes: true } },
  { command: "db:seed", input: { action: "seed", file: "dump.sql.gz", yes: false } },
];

describe("db command machine output", () => {
  test("preserves export file paths containing the public default password", async () => {
    const harness = makeSqlTestDeps({ password: "lando" });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        executeDbCommand(harness.deps, {
          action: "export",
          file: "backups/Drupal backup with spaces.sql",
          yes: true,
        }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected export success");

    const tokens = dbCommandRedactionTokens(exit.value);
    expect(tokens).not.toContain("lando");
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:export",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: exit.value },
        redactor: createRedactor("secrets", { values: tokens }),
      }),
    );
    expect(decodeEnvelope(encoded).result).toMatchObject({ file: exit.value.file });
    expect(encoded).not.toContain("[redacted]");
  });

  test("redacts explicitly authored default-valued SQL passwords", async () => {
    for (const authored of [
      { creds: { password: "lando" } },
      { creds: { rootPassword: "lando" } },
      { environment: { MYSQL_PASSWORD: "lando" } },
      { environment: { MYSQL_ROOT_PASSWORD: "lando" } },
    ]) {
      const harness = makeSqlTestDeps({ password: "lando" });
      const landofile = {
        ...harness.deps.landofile,
        services: { database: { type: "mysql:8.0", ...authored } },
      };
      const exit = await Effect.runPromiseExit(
        Effect.scoped(executeDbCommand({ ...harness.deps, landofile }, { action: "export", yes: true })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isFailure(exit)) throw new Error("expected export success");
      expect(dbCommandRedactionTokens(exit.value)).toContain("lando");
    }
  });

  test("always redacts a root password from the planned service environment", async () => {
    const harness = makeSqlTestDeps({ password: "lando", rootPassword: "lando" });
    const landofile = {
      ...harness.deps.landofile,
      services: { database: { type: "mysql:8.0" } },
    };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeDbCommand({ ...harness.deps, landofile }, { action: "export", yes: true })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected export success");
    expect(dbCommandRedactionTokens(exit.value)).toContain("lando");
  });

  test("continues masking configured passwords in export file paths", async () => {
    const secret = "private-password";
    const harness = makeSqlTestDeps({ password: secret });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeDbCommand(harness.deps, { action: "export", file: `${secret}.sql`, yes: true })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected export success");

    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:export",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: exit.value },
        redactor: createRedactor("secrets", { values: dbCommandRedactionTokens(exit.value) }),
      }),
    );
    expect(encoded).not.toContain(secret);
    expect(decodeEnvelope(encoded).result).toMatchObject({ file: expect.stringContaining("[redacted]") });
  });
  test("encodes every command result through the spec redactionTokens hook", async () => {
    const secret = "s3cret-pass";

    for (const { command, input } of successInputs) {
      const harness = makeSqlTestDeps({ password: secret });
      const exit = await Effect.runPromiseExit(Effect.scoped(executeDbCommand(harness.deps, input)));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isFailure(exit)) throw new Error(`expected ${command} success`);

      const tokens = dbCommandRedactionTokens(exit.value);
      expect(tokens).toContain(secret);

      const encoded = await Effect.runPromise(
        encodeCommandResult({
          command,
          resultSchema: DbCommandResult,
          outcome: { _tag: "success", value: exit.value },
          redactor: createRedactor("secrets", { values: tokens }),
        }),
      );
      const envelope = decodeEnvelope(encoded);
      expect(envelope.apiVersion).toBe("v4");
      expect(envelope.command).toBe(command);
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toMatchObject({ service: "database", family: "mysql" });
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain("redactionTokens");
    }
  });

  test("encodes ambiguous-service and confirm-required failures with tags", async () => {
    const ambiguous = await Effect.runPromise(
      encodeCommandResult({
        command: "db:import",
        resultSchema: DbCommandResult,
        outcome: {
          _tag: "failure",
          error: new SqlServiceAmbiguousError({
            message: "Multiple SQL services are available.",
            available: ["analytics", "database"],
            remediation: "Pass --service <name>.",
          }),
        },
        redactor: identityRedactor,
      }),
    );
    const harness = makeSqlTestDeps({ password: "test-password" });
    const denied = await Effect.runPromiseExit(
      Effect.scoped(executeDbCommand(harness.deps, { action: "reset", yes: false })),
    );
    expect(Exit.isFailure(denied)).toBe(true);
    if (!Exit.isFailure(denied) || denied.cause._tag !== "Fail")
      throw new Error("expected tagged reset confirmation failure");
    expect(denied.cause.error).toBeInstanceOf(SqlConfirmRequiredError);
    const confirm = await Effect.runPromise(
      encodeCommandResult({
        command: "db:reset",
        resultSchema: DbCommandResult,
        outcome: { _tag: "failure", error: denied.cause.error },
        redactor: identityRedactor,
      }),
    );

    const ambiguousEnvelope = decodeEnvelope(ambiguous);
    const confirmEnvelope = decodeEnvelope(confirm);
    expect(ambiguousEnvelope.ok).toBe(false);
    expect(confirmEnvelope.ok).toBe(false);
    expect(ambiguousEnvelope.error?._tag).toBe("SqlServiceAmbiguousError");
    expect(confirmEnvelope.error).toMatchObject({
      _tag: "SqlConfirmRequiredError",
      service: "database",
      steps: [expect.objectContaining({ id: "reset", target: "database", destructive: true })],
    });
  });

  test("redacts structured confirmation steps in the machine error", async () => {
    const secret = "private-target";
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:reset",
        resultSchema: DbCommandResult,
        outcome: {
          _tag: "failure",
          error: new SqlConfirmRequiredError({
            message: "Reset requires confirmation.",
            service: "database",
            steps: [{ id: "reset", label: "reset database", target: secret, destructive: true }],
            remediation: "Review the listed steps before using --yes.",
          }),
        },
        redactor: createRedactor("secrets", { values: [secret] }),
      }),
    );
    const envelope = decodeEnvelope(encoded);
    expect(encoded).not.toContain(secret);
    expect(envelope.error?.steps?.[0]?.target).toBe("[redacted]");
  });

  test("preserves snapshot recovery metadata in machine output", async () => {
    // Given
    const snapshot = SnapshotInfo.make({
      id: "snap-before-upgrade",
      store: { app: AppId.make("sql-app"), store: "sql-app_database_data" },
      digest: "sha256:test",
      sizeBytes: 1_572_864,
      createdAt: DateTime.unsafeMake("2026-09-11T10:00:00Z"),
      label: "before-upgrade",
      metadata: {
        sourceRoot: AbsolutePath.make("/workspace/sql-app"),
        ownerKey: "owner:sql-app",
        repoGroupKey: "repository:sql-app",
        service: ServiceName.make("database"),
        volumeInstanceId: "volume-instance:database",
        family: "mysql",
        version: "8.4",
        imageIdentity: "sha256:mysql-runtime",
        recoveryReason: "manual",
      },
    });

    // When
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:snapshots",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: { service: "database", snapshots: [snapshot], steps: [] } },
        redactor: identityRedactor,
      }),
    );
    const envelope = decodeEnvelope(encoded);

    // Then
    expect(envelope.result).toMatchObject({
      snapshots: [
        {
          id: "snap-before-upgrade",
          sizeBytes: 1_572_864,
          label: "before-upgrade",
          metadata: {
            sourceRoot: "/workspace/sql-app",
            ownerKey: "owner:sql-app",
            repoGroupKey: "repository:sql-app",
            version: "8.4",
            recoveryReason: "manual",
          },
        },
      ],
    });
  });
});
