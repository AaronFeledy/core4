import { expect, test } from "bun:test";
import { type AppPlan, GlobalConfig, PortablePath } from "@lando/sdk/schema";
import { ConfigService, EnvironmentValueResolver, StateStore } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import { selectPreparedProvider } from "../../src/providers/prepared.ts";
import { applyScratchStartup } from "../../src/scratch-app/startup.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const mount = {
  type: "volume" as const,
  store: "web-data",
  target: PortablePath.make("/var/www/html"),
  origin: "service" as const,
  readOnly: false,
};
const recorded: AppPlan = {
  ...plan,
  identity: { appRoot: plan.root, ownerKey: "owner" },
  services: { [web.name]: { ...web, mounts: [mount] } },
  stores: [{ name: "web-data", scope: "app", kind: "data" }],
};
const configLayer = Layer.succeed(
  ConfigService,
  ConfigService.of({
    load: Effect.succeed(Schema.decodeUnknownSync(GlobalConfig)({})),
    get: (key) => Effect.succeed(Schema.decodeUnknownSync(GlobalConfig)({})[key]),
  }),
);

const start = async (volumeBaseline: typeof recorded | undefined) => {
  const warnings = makeCommandWarnings(false);
  const harness = makeHarness({
    plannedApp: recorded,
    applyOutcome: () => ({
      changed: true,
      createdVolumes: [{ nativeName: "web-data", generation: "second", ownerRoot: plan.root }],
    }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* selectPreparedProvider(recorded);
      const environmentResolver = yield* EnvironmentValueResolver;
      const stateStore = yield* StateStore;
      const { plan, certificates } = yield* prepareServiceCertificates(recorded);
      yield* applyScratchStartup(
        {
          id: "recreated-scratch",
          plan,
          certificates,
          ...(volumeBaseline === undefined ? {} : { volumeBaseline }),
        },
        { provider, environmentResolver, stateStore, router: TestRouterService },
      );
    }).pipe(
      Effect.provide(Layer.merge(harness.layer, configLayer)),
      Effect.provideService(CommandWarnings, CommandWarnings.of(warnings)),
    ),
  );
  return { warnings: await Effect.runPromise(warnings.list), events: harness.events };
};

test("a scratch restart warns when its recorded data volume is recreated", async () => {
  const result = await start(recorded);

  expect(result.warnings).toMatchObject([
    {
      code: "LANDO_DATA_VOLUME_RECREATED",
      context: { service: "web", volume: "web-data", target: "/var/www/html" },
    },
  ]);
  expect(result.events.filter((event) => event._tag === "message.warn").map((event) => event.body)).toEqual([
    expect.stringContaining("recreated without its previous contents"),
  ]);
});

test("a new scratch with no recorded plan makes no recreated-volume claim", async () => {
  const result = await start(undefined);

  expect(result.warnings).toEqual([]);
  expect(result.events.filter((event) => event._tag === "message.warn")).toEqual([]);
});
