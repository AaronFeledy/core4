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
import { type ContractFailure, makeTestServicePlan, mapProviderFailure, requireContract } from "./_shared.ts";

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
  // Use the application's musl resolver, not a direct query to a chosen nameserver.
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
  // Declare completion intent without starting an extra container or keeping the probe alive.
  const completionPlan = {
    ...plan,
    services: {
      ...plan.services,
      [consumer]: {
        ...base,
        name: consumer,
        primary: false,
        dependsOn: [{ service, condition: "service_completed_successfully" as const, required: true }],
      },
    },
  };
  const checkExit = (exitCode: number) => {
    const failed = lookups.find((lookup) => lookup.exitCode === exitCode);
    return requireContract(
      exitCode === 0,
      failed === undefined
        ? `startup DNS probe for ${service} exited with code ${exitCode}`
        : `could not resolve ${failed.name} at startup; providers must attach networks with aliases before starting the container`,
      { exitCode },
    );
  };

  yield* Effect.gen(function* () {
    const applied = yield* Effect.result(
      Effect.scoped(provider.apply(plan, { reconcile: true, completionPlan })),
    );
    if (Result.isFailure(applied)) {
      // A provider can observe a failed probe before apply returns. Recover its exit code
      // without waiting on a container that may never have started.
      const observed = yield* Effect.result(provider.inspect(target));
      if (
        Result.isSuccess(observed) &&
        observed.success.status === "exited" &&
        observed.success.exitCode !== undefined
      ) {
        yield* checkExit(observed.success.exitCode);
      }
      return yield* Effect.fail(
        mapProviderFailure("apply succeeds for the startup DNS fixture")(applied.failure),
      );
    }
    const { exitCode } = yield* Effect.scoped(provider.waitForExit(target)).pipe(
      mapFailures(mapProviderFailure("waitForExit resolves for the startup DNS probe")),
    );
    yield* checkExit(exitCode);
  }).pipe(
    Effect.onExit(() =>
      provider
        .destroy({ app: plan.id, plan }, { volumes: true })
        .pipe(mapFailures(mapProviderFailure("destroy cleans up the startup DNS fixture")), Effect.asVoid),
    ),
  );
});
