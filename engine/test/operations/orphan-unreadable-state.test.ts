import { expect, test } from "bun:test";
import { unreadableAppliedStateError } from "@lando/container-runtime/applied-state";
import { appliedStateVersionError } from "@lando/sdk/errors";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { tearDownOrphans } from "../../src/operations/orphan-teardown.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const protectingErrors = {
  damaged: (path: string) =>
    unreadableAppliedStateError({ providerId: plan.provider, path, layout: "per-app" }),
  newer: (path: string) =>
    appliedStateVersionError({
      providerId: plan.provider,
      operation: "applied-state.read",
      path,
      storedVersion: 11,
      supportedVersion: 10,
      scope: "app",
    }),
};

test.each(Object.keys(protectingErrors) as Array<keyof typeof protectingErrors>)(
  "orphan sweep reports %s A and continues removing B",
  async (kind) => {
    const a = AppId.make("damaged-a");
    const protecting = protectingErrors[kind](`${plan.root}/isolated-state/damaged-a.json`);
    const b = AppId.make("readable-b");
    const removed: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      bringDownObserved: (service: Parameters<typeof TestRuntimeProvider.bringDownObserved>[0]) =>
        service.app === a
          ? Effect.fail(protecting)
          : Effect.sync(() => {
              removed.push(service.app);
              return { service: service.service, action: "removed" as const };
            }),
    };
    const harness = makeHarness({
      selectProvider: () => Effect.succeed(provider),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
    });
    const result = await Effect.runPromise(
      tearDownOrphans({
        root: plan.root,
        groups: [a, b].map((appId) => ({
          providerId: plan.provider,
          appId,
          volumes: [],
          services: [
            {
              providerId: plan.provider,
              app: appId,
              appRoot: plan.root,
              service: ServiceName.make("web"),
              status: "running" as const,
              publications: { status: "unknown" as const },
            },
          ],
        })),
        options: { volumes: true, purgeCaches: true },
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(removed).toEqual([b]);
    expect(result.services).toEqual(["web"]);
    expect(harness.events.filter((event) => event._tag === "message.warn")).toEqual([
      expect.objectContaining({ body: expect.stringContaining(protecting.remediation) }),
    ]);
  },
);
