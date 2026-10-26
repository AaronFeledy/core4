import { expect, test } from "bun:test";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName, landoNetworkingPlan } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { normalizeNetworks } from "../../src/planner/networks.ts";
import * as PluginRegistry from "../../src/plugins/registry.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const web = ServiceName.make("web");
const db = ServiceName.make("db");

test("normalizes joined external and owned networks and default aliases without altering attachments", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "shop",
    runtime: 4,
    networks: { peer: { external: true, name: "sibling_net" }, extra: {}, unused: {} },
    services: {
      web: {
        image: "alpine",
        networks: { peer: { aliases: ["api"] }, extra: null, default: { aliases: ["www"] } },
      },
      db: { image: "alpine", networks: ["extra"] },
    },
  });
  const intent = await Effect.runPromise(
    normalizeNetworks({
      landofile,
      services: landofile.services ?? {},
      appRoot: "/apps/shop",
      perAppBridge: true,
    }),
  );
  const networking = landoNetworkingPlan({
    slug: "shop",
    serviceNames: ["web", "db"],
    sharedCrossAppNetwork: true,
    ...intent,
  });
  expect(networking.authoredNetworks).toEqual([
    {
      key: "peer",
      name: "sibling_net",
      external: true,
      members: { [web]: { aliases: ["web.shop.internal", "api"] } },
    },
    {
      key: "extra",
      name: "lando-shop_extra",
      external: false,
      driver: "bridge",
      members: { [web]: { aliases: ["web.shop.internal"] }, [db]: { aliases: ["db.shop.internal"] } },
    },
  ]);
  expect(networking.perAppBridge?.aliases).toEqual({ [web]: ["www"] });
  expect(landofile.services?.[web]?.networks).toEqual({
    peer: { aliases: ["api"] },
    extra: {},
    default: { aliases: ["www"] },
  });
});

test("the full planner normalizes attachments without preserving Compose records", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "shop",
    runtime: 4,
    networks: { peer: { external: true, name: "sibling_net" }, extra: {}, unused: {} },
    services: {
      web: {
        image: "node:lts",
        home: false,
        networks: { peer: { aliases: ["api"] }, extra: null, default: { aliases: ["www"] } },
      },
      db: { image: "node:lts", home: false, networks: ["extra"] },
    },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalTestLandofile(landofile, process.cwd()), {
        ...TestRuntimeProvider.capabilities,
        composeServiceFields: { supported: [] },
      }),
    ).pipe(Effect.provide(Planner.layer), Effect.provide(PluginRegistry.layer)),
  );
  expect(
    plan.networking?.authoredNetworks?.map(({ key, name, members }) => ({ key, name, members })),
  ).toEqual([
    { key: "peer", name: "sibling_net", members: { [web]: { aliases: ["web.shop.internal", "api"] } } },
    {
      key: "extra",
      name: "lando-shop_extra",
      members: { [web]: { aliases: ["web.shop.internal"] }, [db]: { aliases: ["db.shop.internal"] } },
    },
  ]);
  expect(plan.networking?.perAppBridge?.aliases).toEqual({ [web]: ["www"] });
  expect(plan.services[web]?.extensions.compose).toBeUndefined();
});

test("rejects default attachments without a per-app bridge", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "global",
    runtime: 4,
    services: { web: { image: "alpine", networks: ["default"] } },
  });
  const result = await Effect.runPromise(
    normalizeNetworks({
      landofile,
      services: landofile.services ?? {},
      appRoot: "/apps/shop",
      perAppBridge: false,
    }).pipe(Effect.result),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(LandofileValidationError);
    expect(result.failure.issues[0]?.path).toEqual(["services", "web", "networks", "default"]);
    expect(result.failure.remediation?.length).toBeGreaterThan(0);
  }
});

test("attributes a global default attachment failure to its authored local layer", async () => {
  const appRoot = "/apps/global";
  const file = `${appRoot}/.lando.local.yml`;
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        { file: `${appRoot}/.lando.yml`, value: { name: "global", runtime: 4 } },
        { file, value: { services: { web: { image: "alpine", networks: ["default"] } } } },
      ],
      { appRoot, file: `${appRoot}/.lando.yml` },
    ),
  );
  const result = await Effect.runPromise(
    normalizeNetworks({
      landofile: compiled.document,
      services: compiled.document.services ?? {},
      appRoot,
      perAppBridge: false,
    }).pipe(Effect.result),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.file).toBe(file);
    expect(result.failure.issues[0]).toMatchObject({
      path: ["services", "web", "networks", "default"],
      source: { file, layer: "local" },
    });
  }
});
