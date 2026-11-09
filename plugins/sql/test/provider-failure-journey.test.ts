import { afterEach, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { dataHelperImage, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { executeDbCommand } from "../src/run.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);

// The runtime stops answering after Lando has checked the database and starts taking the recovery
// snapshot. The real data plane and DataMover sit between the engine and the command result.
test("db:import reports an unreachable runtime with the runtime's own tag and remediation", async () => {
  const unreachable = new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "Failed to connect to the container runtime socket.",
    remediation: "Run `lando doctor` to inspect the Lando runtime. Run `lando setup` if it isn't installed.",
  });
  const reached: string[] = [];
  const dataPlane = makeProviderDataPlane({
    providerId: "lando",
    capabilities: { volumeSnapshot: "native" },
    redactor: createRedactor("secrets", { values: ["journey-password"] }),
    pullHelperImage: () => Effect.succeed({ ref: dataHelperImage.ref, digest: dataHelperImage.digest }),
    api: {
      request: (input) => {
        reached.push(`${input.method} ${input.path.split("?")[0]}`);
        return Effect.fail(unreachable);
      },
    },
  });
  const fixture = await makeRetentionTestDeps(
    { password: "journey-password" },
    { snapshotVolume: dataPlane.snapshotVolume },
  );

  const exit = await Effect.runPromiseExit(
    Effect.scoped(executeDbCommand(fixture.deps, { action: "import", file: "dump.sql", yes: true })),
  );

  if (!Exit.isFailure(exit)) throw new Error("expected the import to fail");
  expect(reached).toHaveLength(3);
  expect(reached[0]).toBe("GET /containers/json");
  expect(reached[1]).toBe("POST /containers/create");
  expect(reached[2]).toMatch(/^DELETE \/containers\/lando-lando-data-/);
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  const encoded = await Effect.runPromise(
    encodeCommandResult({
      command: "db:import",
      resultSchema: DbCommandResult,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(encoded));
  expect(envelope.ok).toBe(false);
  expect(envelope.error).toMatchObject({
    _tag: "DataTransferError",
    operation: "snapshotVolume",
    remediation: unreachable.remediation,
    cause: {
      _tag: "ProviderUnavailableError",
      message: unreachable.message,
      remediation: unreachable.remediation,
    },
  });
  expect(encoded).not.toContain("journey-password");
  expect(fixture.captured).toEqual([]);
});
