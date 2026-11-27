import { expect, test } from "bun:test";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { makeProviderPlanState } from "../src/provider-assembly.ts";
import { makeResourceOwnershipStore } from "../src/resource-ownership.ts";

const providerId = ProviderId.make("lando");
const dataRoot = AbsolutePath.make("/roots/local");
const appRoot = AbsolutePath.make("/apps/legacy");
const appId = AppId.make("legacy");
const ctx = { providerId: "lando", remediation: "Retry.", env: {} };

// A listed row that carries the container id and labels but no native name, as list responses may.
const row: ServiceRuntimeInfo = {
  app: appId,
  appRoot,
  providerId,
  service: ServiceName.make("web"),
  status: "running",
  containerId: "legacy-id",
  publications: { status: "unknown" },
};

const stopLegacy = async (receipted: boolean) => {
  const appliedPlanState = makePluginStateStore(makeTestStateStore().service, dataRoot, {
    enforce: async () => undefined,
    verify: async () => undefined,
  });
  if (receipted)
    await Effect.runPromise(
      makeResourceOwnershipStore(providerId, appliedPlanState).recordAdoption(
        appRoot,
        {
          previousAppId: appId,
          dataRoot,
          receipts: [
            {
              kind: "container",
              nativeName: "legacy-web",
              nativeId: "legacy-id",
              dataRoot,
              providerId,
              appRoot,
              appId,
            },
          ],
        },
        [],
      ),
    );
  const requests: EngineHttpRequest[] = [];
  let status = "running";
  const planState = makeProviderPlanState({
    ctx,
    providerId,
    providerName: "provider-lando",
    capabilities: { volumeSnapshot: "native" as const },
    redactor: {
      redactString: (value: string) => value,
      redactPrefix: (value: string) => value,
      redactValue: (value: unknown) => value,
    },
    userDataRoot: dataRoot,
    appliedPlanState,
    load: () => Effect.succeed(undefined),
    persist: () => Effect.void,
    remove: () => Effect.void,
  });
  const bringDown = planState.bringDownWith({
    api: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          if (request.method === "POST" && request.path === "/containers/legacy-id/stop") {
            status = "exited";
            return { status: 204, body: "" };
          }
          // The container predates data-root labels: only an adoption receipt proves it is ours.
          return {
            status: 200,
            body: JSON.stringify({
              Id: "legacy-id",
              Name: "/legacy-web",
              Config: {
                Labels: { "dev.lando.app": appId, "dev.lando.app-root": appRoot, "dev.lando.service": "web" },
              },
              State: { Status: status, ExitCode: 0 },
            }),
          };
        }),
    },
  });
  const result = await Effect.runPromise(Effect.result(bringDown.observed(row, "stop")));
  return { result, stops: requests.filter((request) => request.method === "POST").map((r) => r.path) };
};

test("an adoption receipt authorizes a listed container that has no native name in its row", async () => {
  const { result, stops } = await stopLegacy(true);
  expect(result._tag).toBe("Success");
  expect(stops).toEqual(["/containers/legacy-id/stop"]);
});

test("without a receipt, an unlabeled legacy container is refused", async () => {
  const { result, stops } = await stopLegacy(false);
  expect(result._tag).toBe("Failure");
  expect(stops).toEqual([]);
});
