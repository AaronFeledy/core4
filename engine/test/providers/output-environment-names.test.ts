import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, AppPlan, ServiceName } from "@lando/sdk/schema";
import { HOST_PROXY_CREDENTIAL_ENV_NAMES } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Redacted, Schema } from "effect";
import { appOutputEnvironmentNames, registerProviderOutput } from "../../src/providers/output-redaction.ts";

const planWith = (environment: Readonly<Record<string, string>>, eligible = false) =>
  Schema.decodeUnknownSync(AppPlan)({
    id: "names",
    name: "names",
    slug: "names",
    root: "/tmp/names",
    provider: "test",
    services: {
      web: {
        name: "web",
        type: "test",
        primary: true,
        provider: "test",
        environment,
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
        extensions: eligible ? { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } } : {},
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
  });

test("requests exact-secret names from desired and applied plans, including removed references", () => {
  const desired = planWith({
    NEW: "${secret:new}",
    STILL: "${secret:current}",
    REMOVED: "now literal",
    TEXT: "prefix ${secret:embedded}",
    PASSWORD: "literal",
  });
  const applied = planWith({
    OLD: "${secret:old}",
    STILL: "${secret:previous}",
    REMOVED: "${secret:removed}",
  });
  expect(appOutputEnvironmentNames([desired, applied])).toEqual({ web: ["NEW", "STILL", "OLD", "REMOVED"] });
});

test("keeps a removed-but-applied service's exact-secret names", () => {
  const applied = planWith({ OLD: "${secret:old}" });
  const desired = { ...applied, services: {} };
  expect(appOutputEnvironmentNames([desired, applied])).toEqual({ web: ["OLD"] });
});

test("requests host-proxy credentials only for eligible services in either plan", () => {
  const applied = planWith({}, true);
  const base = planWith({});
  const web = base.services[ServiceName.make("web")];
  if (web === undefined) throw new Error("Missing test service");
  const desired: AppPlan = {
    ...base,
    services: {
      [web.name]: web,
      [ServiceName.make("ordinary")]: { ...web, name: ServiceName.make("ordinary") },
    },
  };
  expect(appOutputEnvironmentNames([desired, applied])).toEqual({
    web: [...HOST_PROXY_CREDENTIAL_ENV_NAMES],
    ordinary: [],
  });
});

test("invalid and embedded references never expand the generic environment read", () => {
  expect(
    appOutputEnvironmentNames([
      planWith({ INVALID: "${secret:..}", EMBEDDED: "${secret:one}/suffix", PUBLIC: "visible" }),
    ]),
  ).toEqual({ web: [] });
});

test("registration filters applied plans by app and masks values for removed references", async () => {
  const desired = {
    ...planWith({ CURRENT: "${secret:current}", REMOVED: "literal" }),
    root: AbsolutePath.make("/"),
  };
  const applied = planWith({ REMOVED: "${secret:old}" });
  const foreign = { ...planWith({ FOREIGN: "${secret:foreign}" }), id: AppId.make("foreign") };
  const requested: Readonly<Record<string, ReadonlyArray<string>>>[] = [];
  const redaction = makeRedactionService();
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      yield* registerProviderOutput({
        target: { app: desired.id, plan: desired },
        appliedPlans: [applied, foreign],
        provider: {
          ...TestRuntimeProvider,
          readAppEnvironment: (_target, names) =>
            Effect.sync(() => {
              expect(_target.plan).toBeUndefined();
              requested.push(names);
              return [Redacted.make("removed-applied-private")];
            }),
        },
      });
      return (yield* redaction.forProfile("secrets")).redactString("removed-applied-private");
    }).pipe(Effect.provideService(RedactionService, redaction)),
  );
  expect(requested).toEqual([{ web: ["CURRENT", "REMOVED"] }]);
  expect(output).toBe("[redacted]");
});
