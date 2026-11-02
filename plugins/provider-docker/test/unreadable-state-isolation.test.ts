import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { Effect, Stream } from "effect";
import { listAppliedPlans, persistAppliedPlan } from "../src/applied-state.ts";
import { makeRuntimeProvider } from "../src/index.ts";
import { webFor, withInventory } from "./resource-ownership-support.ts";

for (const operation of ["stop", "destroy", "inspect", "logs"] as const) {
  test(`${operation} for readable app B tolerates unreadable app A in isolated state`, async () => {
    await withInventory(async ({ state, plan, root }) => {
      const a = webFor(plan);
      const b = webFor({ ...plan, id: AppId.make("readable-b"), slug: "readable-b" });
      const path = await Effect.runPromise(persistAppliedPlan(state, a));
      await Effect.runPromise(persistAppliedPlan(state, b));
      await writeFile(path, "invalid json");
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          appliedPlanState: state,
          appliedPlanStateDir: `${root}/plugin-state`,
          dockerApi: {
            info: Effect.succeed({}),
            stream: () => Stream.empty,
            request: (request) =>
              Effect.succeed({
                status: request.method === "GET" ? 200 : 204,
                body:
                  request.method === "GET"
                    ? JSON.stringify({
                        Id: "b-native",
                        State: { Status: "running", Running: true },
                        Labels: {
                          "dev.lando.app": b.id,
                          "dev.lando.app-root": root,
                          "dev.lando.owner": b.identity?.ownerKey,
                          "dev.lando.provider": "docker",
                        },
                        ...(request.path.startsWith("/networks/")
                          ? {}
                          : {
                              Config: {
                                Labels: {
                                  "dev.lando.app": b.id,
                                  "dev.lando.app-root": root,
                                  "dev.lando.service": "web",
                                  "dev.lando.owner": b.identity?.ownerKey,
                                  "dev.lando.provider": "docker",
                                },
                              },
                            }),
                      })
                    : "",
              }),
          },
        }),
      );
      const target = { app: b.id, service: ServiceName.make("web") };
      const action =
        operation === "stop"
          ? provider.stop(target)
          : operation === "destroy"
            ? provider.destroy({ app: b.id }, { volumes: false })
            : operation === "inspect"
              ? provider.inspect(target)
              : Stream.runCollect(provider.logs(target, { follow: false, tail: 10 }));
      await Effect.runPromise(action.pipe(Effect.scoped));
      const refusal = await Effect.runPromise(provider.stop({ ...target, app: a.id }).pipe(Effect.flip));
      expect(refusal).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
      expect(refusal.message).toContain(path);
    });
  });
}

test("strict inventory preserves B and reports unreadable A by filename and path", async () => {
  await withInventory(async ({ state, plan, root }) => {
    const b = { ...plan, id: AppId.make("readable-b"), slug: "readable-b" };
    const path = await Effect.runPromise(persistAppliedPlan(state, plan));
    await Effect.runPromise(persistAppliedPlan(state, b));
    await writeFile(path, "invalid json");
    const inventory = await Effect.runPromise(listAppliedPlans(state, `${root}/plugin-state`));
    expect(inventory.plans.map((item) => item.id)).toEqual([b.id]);
    expect(inventory.unreadable).toEqual([{ appId: plan.id, path }]);
  });
});

test("ownership sweep skips and reports unreadable A while removing B's labeled resources", async () => {
  await withInventory(async ({ state, store, plan, root }) => {
    const a = webFor(plan);
    const b = webFor({ ...plan, id: AppId.make("readable-b"), slug: "readable-b" });
    const path = await Effect.runPromise(persistAppliedPlan(state, a));
    await Effect.runPromise(persistAppliedPlan(state, b));
    await Effect.runPromise(store.prepare(a));
    await Effect.runPromise(store.prepare(b));
    await writeFile(path, "invalid json");
    const calls: string[] = [];
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        appliedPlanStateDir: `${root}/plugin-state`,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync(() => {
              calls.push(`${request.method} ${request.path}`);
              return request.method === "DELETE"
                ? { status: 204, body: "" }
                : {
                    status: 200,
                    body: JSON.stringify({
                      Id: "b-native",
                      ...(request.path.startsWith("/networks/")
                        ? {}
                        : {
                            Config: {
                              Labels: {
                                "dev.lando.app": b.id,
                                "dev.lando.app-root": root,
                                "dev.lando.service": "web",
                                "dev.lando.owner": b.identity?.ownerKey,
                                "dev.lando.provider": "docker",
                              },
                            },
                          }),
                      Labels: {
                        "dev.lando.app": b.id,
                        "dev.lando.app-root": root,
                        "dev.lando.owner": b.identity?.ownerKey,
                        "dev.lando.provider": "docker",
                      },
                    }),
                  };
            }),
        },
      }),
    );
    const result = await Effect.runPromise(
      provider.cleanupOwnedResources?.(root, { volumes: false }) ?? Effect.die("missing cleanup"),
    );
    expect(result.servicesRemoved).toEqual([ServiceName.make("web")]);
    expect(result.skipped?.map((entry) => entry.appId)).toEqual([a.id, a.id]);
    expect(result.skipped?.every((entry) => entry.reason.includes(path))).toBe(true);
    expect(calls.some((call) => call.includes("lando-owned"))).toBe(false);
    expect((await Effect.runPromise(store.load(root)))?.appIds).toEqual([a.id]);
  });
});
