import { expect, test } from "bun:test";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { invocationToolingForPlan, sitesUnder } from "../../src/planner/invocation-authority.ts";
import {
  materializeLandofileScopesForPlan,
  serviceCredsScopeForPlan,
} from "../../src/planner/landofile-scopes.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as Planner from "../../src/services/planner.ts";
import { resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const root = process.cwd();
const cases = [
  { name: "literal", authored: "redis-password", password: "redis-password" },
  {
    name: "SecretRef",
    authored: "${secret:REDIS_PASSWORD}",
    password: { _tag: "SecretRef", reference: "REDIS_PASSWORD" },
  },
] as const;

const planRedis = (password: string | undefined, withConsumer = false) =>
  Effect.gen(function* () {
    const compiled = yield* compileTestLandofile(
      {
        name: "redis-creds",
        services: {
          ...(withConsumer
            ? {
                web: {
                  type: "lando",
                  image: "alpine:3",
                  home: false,
                  environment: { PASSWORD: "{{ services.cache.creds.password }}" },
                },
              }
            : {}),
          cache: { type: "redis", ...(password === undefined ? {} : { password }) },
        },
      },
      root,
    );
    const planner = yield* AppPlanner;
    return yield* planner.plan(compiled, TestRuntimeProvider.capabilities);
  }).pipe(Effect.provide(Planner.layer), Effect.provide(Registry.layer));

test.each([...cases])(
  "publishes $name Redis credentials before a dependent service resolves",
  async ({ authored, password }) => {
    // Given / When
    const plan = await Effect.runPromise(planRedis(authored, true));
    // Then
    expect(plan.services[ServiceName.make("web")]?.environment.PASSWORD).toEqual(password);
    expect(plan.services[ServiceName.make("cache")]?.environment.REDISCLI_AUTH).toEqual(password);
    expect(effectiveToolingForPlan(plan)?.["redis-cli"]?.env?.REDISCLI_AUTH).toEqual(password);
    expect(serviceCredsScopeForPlan(plan).cache).toEqual({
      creds: { user: "default", database: "0", password },
    });
  },
);

test.each([...cases])(
  "retains $name Redis credentials through AppPlan JSON and invocation scopes",
  async ({ authored, password }) => {
    // Given
    const planned = await Effect.runPromise(planRedis(authored));
    const persisted = Schema.decodeUnknownSync(AppPlan)(
      JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(planned))),
      { onExcessProperty: "error" },
    );
    const invocation = await Effect.runPromise(
      compileTestLandofile(
        {
          name: "redis-creds",
          tooling: {
            check: {
              cmd: "echo",
              env: { PASSWORD: "{{ event.use ? services.cache.creds.password : 'unused' }}" },
            },
          },
        },
        root,
      ),
    );
    // When
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* materializeLandofileScopesForPlan(
          {
            landofile: invocation,
            appRoot: root,
            landofilePath: `${root}/.lando.yml`,
            globalConfig: undefined,
          },
          persisted,
        );
        const effective = yield* invocationToolingForPlan(compiled, persisted, "lndo.site");
        const task = effective.tooling.check;
        if (task === undefined) return yield* Effect.die("Missing check task");
        return yield* resolveToolingTaskShape(
          task,
          { event: { use: true } },
          sitesUnder(effective.sites, ["tooling", "check"]),
        );
      }),
    );
    // Then
    expect(resolved.env?.PASSWORD).toEqual(password);
    expect(persisted.services[ServiceName.make("cache")]?.connection).toBeUndefined();
  },
);

test("publishes no credentials when Redis has no password", async () => {
  // Given / When
  const plan = await Effect.runPromise(planRedis(undefined));
  // Then
  expect(serviceCredsScopeForPlan(plan)).not.toHaveProperty("cache");
});

test("rejects a credential expression when Redis has no password", async () => {
  // Given / When
  const result = await Effect.runPromise(planRedis(undefined, true).pipe(Effect.result));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ConfigExpressionError" } });
});
