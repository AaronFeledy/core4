import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { listSpec } from "../../src/cli/command-specs/apps/list.ts";
import {
  appsFromContainerList,
  discoverRunningAppsEvidenceFromSockets,
} from "../../src/cli/commands/list-discovery.ts";
import {
  AppsListResultSchema,
  type ListServicesOptions,
  appliedPlansDirectory,
  listServices,
  renderAppsListResult,
} from "../../src/cli/commands/list.ts";

const config = Schema.decodeUnknownSync(GlobalConfig)({});

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
          listServices({
            userDataRoot: root,
            userCacheRoot: root,
            discoverContainersEvidence: async () => ({
              apps: appsFromContainerList(containers),
              confirmedProviderIds: fixture.providers,
              ownedAppIds: containers.length > 0 ? [appId] : [],
            }),
          }).pipe(
            Effect.provideService(ConfigService, {
              load: Effect.succeed(config),
              get: (key) => Effect.succeed(config[key]),
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
        listServices({
          userDataRoot: root,
          userCacheRoot: root,
          discoverContainersEvidence,
        }).pipe(
          Effect.provideService(ConfigService, {
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
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
