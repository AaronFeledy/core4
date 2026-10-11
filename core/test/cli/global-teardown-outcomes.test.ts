import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { AbsolutePath, AppId, type VolumeInfo } from "@lando/sdk/schema";
import {
  GlobalDestroyResultSchema,
  globalDestroy,
  renderGlobalDestroyResult,
} from "../../src/cli/commands/meta/global-destroy.ts";
import {
  GlobalStopResultSchema,
  globalStop,
  renderGlobalStopResult,
} from "../../src/cli/commands/meta/global-stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../_support/global-teardown-harness.ts";

for (const evidence of ["absent", "applied", "destroyed", "volume", "preserved-volume"] as const) {
  for (const command of ["stop", "destroy"] as const) {
    for (const materialized of [false, true]) {
      test(`${command} reports ${evidence} outcome with materialized=${materialized}`, async () => {
        // Given no resources, a provider no-op, or only an owned data volume.
        const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-global-outcomes-")));
        try {
          const root = AbsolutePath.make(join(dataRoot, "global"));
          if (materialized) {
            await mkdir(root);
            await writeFile(join(root, ".lando.dist.yml"), "services: [\n");
          }
          const volume: VolumeInfo = {
            ref: { app: AppId.make("global"), store: "data" },
            labels: { "dev.lando.scope": evidence === "preserved-volume" ? "global" : "app" },
            identity: {
              ownerRoot: root,
              nativeName: "data",
              coordinationKey: "data",
              generation: "generation",
              origin: "created",
            },
          };
          const harness = await globalTeardownHarness(dataRoot, {
            ...(evidence === "applied" || evidence === "destroyed" ? { plan: globalPlanAt(root) } : {}),
            volumes: evidence === "volume" || evidence === "preserved-volume" ? [volume] : [],
            destroyOutcome:
              evidence === "destroyed" ? { kind: "destroyed" } : { kind: "no-op", reason: "no-applied-plan" },
          });
          // When stop preserves volumes or destroy requests purge.
          const result =
            command === "stop"
              ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
              : await Effect.runPromise(
                  globalDestroy({ yes: true, purge: true }).pipe(Effect.provide(harness.layer)),
                );
          // Then both the machine contract and text report actual mutation, not installation or intent.
          const changed = evidence === "destroyed" || (evidence === "volume" && command === "destroy");
          const outcome = changed ? (command === "stop" ? "stopped" : "destroyed") : "unchanged";
          expect(result).toMatchObject({ outcome, materialized });
          const rendered =
            "servicesStopped" in result
              ? renderGlobalStopResult(Schema.decodeUnknownSync(GlobalStopResultSchema)(result))
              : renderGlobalDestroyResult(Schema.decodeUnknownSync(GlobalDestroyResultSchema)(result));
          expect(rendered).toStartWith(`${outcome}:`);
          const services = evidence === "destroyed" ? ["ssh-agent"] : [];
          if ("servicesDestroyed" in result) {
            expect(result.servicesDestroyed).toEqual(services);
            expect(result.volumesRemoved).toBe(changed);
          } else expect(result.servicesStopped).toEqual(services);
          if (evidence === "volume" && changed) {
            expect(harness.calls).toContain("removeVolume");
            expect(rendered).toContain("volumes removed");
            expect(rendered).not.toContain("not installed");
          }
        } finally {
          await rm(dataRoot, { recursive: true, force: true });
        }
      });
    }
  }
}
