import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { deriveToolInputSchema, validateToolInput } from "@lando/mcp/registry";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { McpToolInputError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { appsListStatusFromInput, listSpec } from "../../src/cli/command-specs/apps/list.ts";
import {
  appsFromContainerList,
  discoverRunningAppsEvidenceFromSockets,
} from "../../src/cli/commands/list-discovery.ts";
import {
  APPS_LIST_STATUSES,
  AppsListResultSchema,
  type ListServicesOptions,
  type ListServicesResult,
  appliedPlansDirectory,
  listServices,
  renderAppsListResult,
} from "../../src/cli/commands/list.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { applyJqToRedactedJsonLine } from "../../src/cli/jq/eval.ts";

const config = Schema.decodeUnknownSync(GlobalConfig)({});

const provideConfig = <A, E, R>(effect: Effect.Effect<A, E, R | ConfigService>) =>
  effect.pipe(
    Effect.provideService(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    ),
  );

const writeAppliedPlan = async (
  dir: string,
  app: { readonly id: string; readonly root: string; readonly provider: string },
): Promise<void> => {
  await writeFile(
    join(dir, `${app.id}.json`),
    JSON.stringify({
      version: 1,
      data: { id: app.id, name: app.id, root: app.root, provider: app.provider, services: { web: {} } },
    }),
  );
};

const cases = [
  { name: "no containers remain", containers: [], providers: ["lando"], status: "stopped" },
  { name: "only stopped containers remain", containers: ["exited"], providers: ["lando"], status: "stopped" },
  { name: "a service is running", containers: ["running", "exited"], providers: ["lando"], status: "active" },
  { name: "the runtime is unreachable", containers: [], providers: [], status: "unknown" },
  { name: "only another provider responds", containers: [], providers: ["docker"], status: "unknown" },
] as const;

for (const fixture of cases) {
  for (const appId of ["retained", "global"]) {
    test(`reports ${fixture.status} for ${appId} when ${fixture.name}`, async () => {
      // Given a retained plan whose root still exists, independently of container state.
      const root = await mkdtemp(join(tmpdir(), "lando-list-status-"));
      try {
        const dir = appliedPlansDirectory(root);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `${appId}.json`),
          JSON.stringify({
            version: 1,
            data: { id: appId, root, provider: "lando", services: { web: {}, database: {} } },
          }),
        );
        const containers = fixture.containers.map((State, index) => ({
          State,
          Labels: {
            "dev.lando.app": appId,
            "dev.lando.provider": "lando",
            "dev.lando.service": `service-${index}`,
          },
        }));

        // When runtime discovery is merged with the retained inventory.
        const result = await Effect.runPromise(
          provideConfig(
            listServices({
              userDataRoot: root,
              userCacheRoot: root,
              discoverContainersEvidence: async () => ({
                apps: appsFromContainerList(containers),
                confirmedProviderIds: fixture.providers,
                ownedAppIds: containers.length > 0 ? [appId] : [],
              }),
            }),
          ),
        );

        // Then both machine output and the table report runtime state, not registry presence.
        expect(result.apps).toMatchObject([{ appId, status: fixture.status }]);
        expect(Schema.encodeSync(AppsListResultSchema)(result)).toEqual(result);
        expect(renderAppsListResult(result).trim().split("\n")[1]?.trim().split(/\s+/u)[1]).toBe(
          fixture.status,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const failure of ["missing socket", "rejected discovery"] as const) {
  test(`returns unknown without failing when discovery has a ${failure}`, async () => {
    // Given persisted state and an unavailable discovery transport.
    const root = await mkdtemp(join(tmpdir(), "lando-list-unreachable-"));
    try {
      const dir = appliedPlansDirectory(root);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "retained.json"),
        JSON.stringify({
          id: "retained",
          root,
          provider: "lando",
          services: { web: {} },
        }),
      );
      const discoverContainersEvidence: ListServicesOptions["discoverContainersEvidence"] =
        failure === "missing socket"
          ? () => discoverRunningAppsEvidenceFromSockets(root, [join(root, "missing.sock")])
          : () => Promise.reject(new TypeError("unreachable test transport"));

      // When discovery cannot obtain runtime evidence.
      const result = await Effect.runPromise(
        provideConfig(
          listServices({
            userDataRoot: root,
            userCacheRoot: root,
            discoverContainersEvidence,
          }),
        ),
      );

      // Then inventory remains available with an explicit unknown status.
      expect(result.apps).toMatchObject([{ appId: "retained", status: "unknown" }]);
      expect(listSpec.bootstrap).toBe("minimal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const mixedStatusInventory = async (
  root: string,
  options: ListServicesOptions = {},
): Promise<{ readonly result: ListServicesResult; readonly discoveryCalls: number }> => {
  const dir = appliedPlansDirectory(root);
  await mkdir(dir, { recursive: true });
  await writeAppliedPlan(dir, { id: "alpha", root, provider: "lando" });
  await writeAppliedPlan(dir, { id: "bravo", root, provider: "lando" });
  await writeAppliedPlan(dir, { id: "charlie", root, provider: "docker" });
  let discoveryCalls = 0;
  const result = await Effect.runPromise(
    provideConfig(
      listServices({
        userDataRoot: root,
        userCacheRoot: root,
        discoverContainersEvidence: async () => {
          discoveryCalls += 1;
          return {
            apps: appsFromContainerList([
              {
                State: "running",
                Labels: {
                  "dev.lando.app": "alpha",
                  "dev.lando.provider": "lando",
                  "dev.lando.service": "web",
                },
              },
            ]),
            confirmedProviderIds: ["lando"],
            ownedAppIds: ["alpha"],
          };
        },
        ...options,
      }),
    ),
  );
  return { result, discoveryCalls };
};

test("filters mixed runtime statuses after a single discovery pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-list-status-filter-"));
  try {
    const unfiltered = await mixedStatusInventory(root);
    expect(unfiltered.discoveryCalls).toBe(1);
    expect(unfiltered.result.apps).toMatchObject([
      { appId: "alpha", status: "active" },
      { appId: "bravo", status: "stopped" },
      { appId: "charlie", status: "unknown" },
    ]);

    const active = await mixedStatusInventory(root, { status: ["active"] });
    expect(active.discoveryCalls).toBe(1);
    expect(active.result.apps).toMatchObject([{ appId: "alpha", status: "active" }]);
    expect(Schema.encodeSync(AppsListResultSchema)(active.result)).toEqual(active.result);
    expect(renderAppsListResult(active.result)).toContain("alpha");
    expect(renderAppsListResult(active.result)).not.toContain("bravo");
    expect(renderAppsListResult(active.result)).not.toContain("charlie");

    const stoppedAndUnknown = await mixedStatusInventory(root, { status: ["stopped", "unknown"] });
    expect(stoppedAndUnknown.discoveryCalls).toBe(1);
    expect(stoppedAndUnknown.result.apps.map((app) => app.appId)).toEqual(["bravo", "charlie"]);

    const none = await mixedStatusInventory(root, { status: [] });
    expect(none.discoveryCalls).toBe(1);
    expect(none.result.apps).toEqual([]);
    expect(renderAppsListResult(none.result, "table", undefined, { filtered: true })).toBe(
      "No Lando apps match the filters.",
    );
    expect(renderAppsListResult({ apps: [] })).toContain("No Lando apps applied on this host.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apps:list --status extractor accepts repeatable declared values only", () => {
  expect(appsListStatusFromInput(compiledCommandInputFromArgv("apps:list", []))).toBeUndefined();
  expect(appsListStatusFromInput(compiledCommandInputFromArgv("apps:list", ["--status", "active"]))).toEqual([
    "active",
  ]);
  expect(appsListStatusFromInput(compiledCommandInputFromArgv("apps:list", ["--status=stopped"]))).toEqual([
    "stopped",
  ]);
  expect(
    appsListStatusFromInput(
      compiledCommandInputFromArgv("apps:list", ["--status", "active", "--status", "unknown"]),
    ),
  ).toEqual(["active", "unknown"]);
  expect(() => appsListStatusFromInput({ flags: { status: ["running"] } })).toThrow(
    MalformedCliFlagValueError,
  );
  expect(() => appsListStatusFromInput({ flags: { status: ["active", "RUNNING"] } })).toThrow(
    MalformedCliFlagValueError,
  );
  try {
    appsListStatusFromInput({ flags: { status: ["running"] } });
    expect.unreachable("expected MalformedCliFlagValueError");
  } catch (error) {
    expect(error).toMatchObject({
      _tag: "MalformedCliFlagValueError",
      issue: "invalid_option",
      remediation: "Supply --status with one of: active, stopped, unknown.",
    });
    expect(JSON.stringify(error)).not.toContain("running");
  }
  expect(() => compiledCommandInputFromArgv("apps:list", ["--status", "running"])).toThrow(
    MalformedCliFlagValueError,
  );
  expect(() => compiledCommandInputFromArgv("apps:list", ["--status"])).toThrow(MalformedCliFlagValueError);
  expect(listSpec.flags?.status).toMatchObject({
    multiple: true,
    options: APPS_LIST_STATUSES,
  });
});

test("MCP apps:list rejects unknown --status values and advertises the enum", () => {
  expect(deriveToolInputSchema(listSpec)).toMatchObject({
    properties: {
      flags: {
        properties: {
          status: {
            type: "array",
            items: { type: "string", enum: ["active", "stopped", "unknown"] },
          },
        },
      },
    },
  });
  expect(() => validateToolInput(listSpec, { flags: { status: ["running"] } })).toThrow(McpToolInputError);
  expect(() => validateToolInput(listSpec, { flags: { status: ["active", "RUNNING"] } })).toThrow(
    McpToolInputError,
  );
  try {
    validateToolInput(listSpec, { flags: { status: ["running"] } });
    expect.unreachable("expected McpToolInputError");
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolInputError);
    expect(error).toMatchObject({
      _tag: "McpToolInputError",
      toolId: "apps:list",
      path: "flags.status",
    });
    expect((error as McpToolInputError).message).toContain("active, stopped, unknown");
    expect(JSON.stringify(error)).not.toContain("running");
  }
  expect(validateToolInput(listSpec, { flags: { status: ["active"] } }).flags.status).toEqual(["active"]);
});

test("documented --jq app-root path reads the real command envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-list-status-jq-"));
  try {
    const { result } = await mixedStatusInventory(root, { status: ["active"] });
    const envelope = await Effect.runPromise(
      encodeCommandResult({
        command: "apps:list",
        resultSchema: AppsListResultSchema,
        outcome: { _tag: "success", value: result },
        redactor: identityRedactor,
      }),
    );
    const selected = await applyJqToRedactedJsonLine(
      envelope,
      '.result.apps[] | select(.appName=="alpha") | .appRoot',
    );
    expect(selected).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
