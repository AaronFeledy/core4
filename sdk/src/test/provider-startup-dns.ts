import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { mapFailures } from "../command-result/failure.ts";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  ServiceName,
  landoNetworkingPlan,
} from "../schema/index.ts";
import type { RuntimeProviderShape } from "../services/index.ts";
import { type ContractFailure, contractFailure, makeTestServicePlan, mapProviderFailure } from "./_shared.ts";

export const checkProviderStartupDns = Effect.fnUntraced(function* (
  provider: RuntimeProviderShape,
  fixture: CurrentExecutableAppPlan,
): Effect.fn.Return<void, ContractFailure> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = `sdk-dns-${suffix}`;
  const service = ServiceName.make(`lookup-${suffix}`);
  const lookups = [
    { name: service, exitCode: 41 },
    { name: `${service}.${slug}.internal`, exitCode: 42 },
  ];
  // Use the application's musl resolver. Retrying would hide aliases attached too late.
  const script = `
    const { lookup } = require('node:dns').promises;
    Promise.all(${JSON.stringify(lookups)}.map(({ name, exitCode }) =>
      lookup(name).then(() => 0, () => exitCode)
    )).then(codes => { process.exitCode = codes.find(Boolean) ?? 0; });
  `;
  const base = makeTestServicePlan(fixture.provider);
  const plan: CurrentExecutableAppPlan = {
    ...fixture,
    id: AppId.make(slug),
    name: slug,
    slug,
    root: AbsolutePath.make(join(tmpdir(), slug)),
    networking: landoNetworkingPlan({
      slug,
      serviceNames: [service],
      sharedCrossAppNetwork: provider.capabilities.sharedCrossAppNetwork,
    }),
    services: { [service]: { ...base, name: service, entrypoint: ["node"], command: ["-e", script] } },
  };
  const target = { app: plan.id, service, plan };
  const consumer = ServiceName.make("consumer");
  // The dependency lets apply accept an immediate exit 0 without starting the consumer.
  const completionPlan: CurrentExecutableAppPlan = {
    ...plan,
    services: {
      ...plan.services,
      [consumer]: {
        ...base,
        name: consumer,
        primary: false,
        dependsOn: [{ service, condition: "service_completed_successfully", required: true }],
      },
    },
  };
  const checkExit = (exitCode: number) => {
    if (exitCode === 0) return Effect.void;
    const failed = lookups.find((lookup) => lookup.exitCode === exitCode);
    return Effect.fail(
      contractFailure(
        failed === undefined
          ? `startup DNS probe for ${service} exited with code ${exitCode}`
          : `could not resolve ${failed.name} at startup; providers must attach networks with aliases before starting the container`,
        { exitCode },
      ),
    );
  };

  yield* Effect.gen(function* () {
    const applied = yield* Effect.result(
      Effect.scoped(provider.apply(plan, { reconcile: true, completionPlan })),
    );
    if (Result.isSuccess(applied)) {
      const { exitCode } = yield* Effect.scoped(provider.waitForExit(target)).pipe(
        mapFailures(mapProviderFailure("waitForExit resolves for the startup DNS probe")),
      );
      return yield* checkExit(exitCode);
    }

    // Apply can fail because the probe exited early or because it never started.
    const observed = yield* Effect.result(provider.inspect(target));
    if (
      Result.isSuccess(observed) &&
      observed.success.status === "exited" &&
      observed.success.exitCode !== undefined
    ) {
      yield* checkExit(observed.success.exitCode);
    }
    return yield* Effect.fail(contractFailure("apply succeeds for the startup DNS fixture", applied.failure));
  }).pipe(
    Effect.onExit(() =>
      provider
        .bringDown({ app: plan.id, plan }, { containers: "remove", volumes: true })
        .pipe(mapFailures(mapProviderFailure("destroy cleans up the startup DNS fixture")), Effect.asVoid),
    ),
  );
});
