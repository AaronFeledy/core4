import { Cause, Effect, Option, Schema } from "effect";
import { canonicalJson } from "../digest/index.ts";
import type { AppFeatureError, ServiceFeatureError } from "../errors/index.ts";
import { EndpointPlan } from "../schema/index.ts";
import type {
  AppEndpointDeclarationContext,
  AppFeatureContext,
  AppFeatureDefinition,
  ServiceEndpointContext,
  ServiceFeatureDefinition,
} from "../services/index.ts";
import { ContractFailure } from "./_shared.ts";

const isServiceDeclaration = Schema.is(Schema.Array(EndpointPlan));
const isAppDeclaration = Schema.is(Schema.Record(Schema.String, Schema.Array(EndpointPlan)));

const asContractFailure = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ContractFailure> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause);
      return Effect.fail(
        Option.isSome(failure) && failure.value instanceof ContractFailure
          ? failure.value
          : new ContractFailure({
              assertion: "endpoint declaration succeeds",
              message: "Endpoint declaration contract failed",
              details: Cause.pretty(cause),
            }),
      );
    }),
  );

const invokeDeclaration = Effect.fnUntraced(function* <A, E>(
  declare: () => Effect.Effect<A, E>,
  facts: ServiceEndpointContext | AppEndpointDeclarationContext,
  assertion: string,
): Effect.fn.Return<A, E | ContractFailure> {
  const before = canonicalJson(facts);
  const declared = yield* Effect.suspend(declare);
  if (canonicalJson(facts) !== before)
    return yield* Effect.fail(
      new ContractFailure({
        assertion,
        message: `Endpoint declaration contract failed: ${assertion}`,
      }),
    );
  return declared;
});

export const serviceEndpointDeclarations = Effect.fnUntraced(function* (
  feature: ServiceFeatureDefinition,
  context: ServiceEndpointContext,
): Effect.fn.Return<readonly EndpointPlan[], ContractFailure | ServiceFeatureError> {
  const declare = feature.declareEndpoints;
  if (declare === undefined) return [];
  const facts: ServiceEndpointContext = {
    serviceName: context.serviceName,
    serviceType: context.serviceType,
    base: context.base,
    primary: context.primary,
    appName: context.appName,
    appRoot: context.appRoot,
    host: context.host,
    normalizedConfig: context.normalizedConfig,
    connection: context.connection,
    config: context.config,
  };
  const declared = yield* invokeDeclaration(
    () => declare(facts),
    facts,
    "service feature endpoint declaration facts are immutable",
  );
  if (!isServiceDeclaration(declared))
    return yield* Effect.fail(
      new ContractFailure({
        assertion: "service feature endpoint declarations match EndpointPlan",
        message: "ServiceFeature declared invalid EndpointPlan values",
      }),
    );
  return declared;
}, asContractFailure);

export const appEndpointDeclarations = Effect.fnUntraced(function* (
  feature: AppFeatureDefinition,
  context: AppFeatureContext,
): Effect.fn.Return<Readonly<Record<string, readonly EndpointPlan[]>>, ContractFailure | AppFeatureError> {
  const declare = feature.declareEndpoints;
  if (declare === undefined) return {};
  const facts = {
    featureId: context.featureId,
    appName: context.appName,
    appRoot: context.appRoot,
    config: context.config,
    selected: context.selected,
  };
  const declarations = yield* invokeDeclaration(
    () => declare(facts),
    facts,
    "app feature endpoint declaration facts are immutable",
  );
  if (!isAppDeclaration(declarations))
    return yield* Effect.fail(
      new ContractFailure({
        assertion: "app feature endpoint declarations match EndpointPlan",
        message: "AppFeature declared invalid EndpointPlan values",
      }),
    );
  const before = canonicalJson(declarations);
  const repeated = yield* invokeDeclaration(
    () => declare(facts),
    facts,
    "app feature endpoint declaration facts are immutable",
  );
  if (!isAppDeclaration(repeated))
    return yield* Effect.fail(
      new ContractFailure({
        assertion: "app feature endpoint declarations match EndpointPlan",
        message: "AppFeature declared invalid EndpointPlan values",
      }),
    );
  const checks = [
    [before === canonicalJson(repeated), "app feature endpoint declarations are deterministic"],
    [
      Object.keys(declarations).every((name) =>
        context.selected.some((service) => service.serviceName === name),
      ),
      "app feature declares endpoints only for selected services",
    ],
    [
      !Object.values(declarations)
        .flat()
        .some((endpoint) => "realization" in endpoint),
      "app feature emits endpoint intent without realization decisions",
    ],
  ] as const;
  for (const [valid, assertion] of checks) {
    if (!valid)
      return yield* Effect.fail(
        new ContractFailure({
          assertion,
          message: `AppFeature contract failed: ${assertion}`,
          details: declarations,
        }),
      );
  }
  return declarations;
}, asContractFailure);
