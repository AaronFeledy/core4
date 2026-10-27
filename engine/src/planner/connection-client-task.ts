import type { InvocationProgram } from "@lando/landofile/compiled-sites";
import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import { PlanReplanRequiredError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  type LandofileShape,
  type ToolingTaskShape,
  appIdentityKey,
  planAppIdentity,
} from "@lando/sdk/schema";
import { PluginRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { connectionClientsForPlan } from "./effective-tooling.ts";

export const resolveConnectionClientTask = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly name: string;
  readonly task: ToolingTaskShape;
  readonly sites: InvocationProgram;
  readonly currentLandofile?: Pick<LandofileShape, "tooling" | "toolingDefaults">;
}) {
  const owner = connectionClientsForPlan(input.plan)[input.name];
  if (owner === undefined || Object.hasOwn(input.currentLandofile?.tooling ?? {}, input.name))
    return { task: input.task, sites: input.sites };
  const refusal = (cause?: unknown) =>
    new PlanReplanRequiredError({
      app: input.plan.id,
      providerId: input.plan.provider,
      operation: "database connection",
      message: `Applied connection facts for generated client ${input.name} are unavailable or incompatible.`,
      remediation: "Run `lando start` to apply the database plan, then retry.",
      cause,
    });
  const refused = refusal();
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  const plugins = yield* Effect.serviceOption(PluginRegistry);
  if (Option.isNone(registry) || Option.isNone(plugins)) return yield* Effect.fail(refused);
  const root = AbsolutePath.make(
    yield* canonicalMissingAppRoot(input.plan.root).pipe(Effect.mapError(refusal)),
  );
  const plans = yield* registry.value.appliedPlansFor(root).pipe(Effect.mapError(refusal));
  const owned = plans.filter(
    (plan) =>
      plan.id === input.plan.id &&
      plan.provider === input.plan.provider &&
      planAppIdentity(plan).appRoot === root &&
      planAppIdentity(plan).ownerKey === appIdentityKey("owner", root),
  );
  const applied = owned.length === 1 ? owned[0] : undefined;
  const service = applied?.services[owner];
  const desired = input.plan.services[owner];
  if (
    service?.connection === undefined ||
    desired?.connection === undefined ||
    service.connection.family !== desired.connection.family ||
    service.provider !== input.plan.provider
  )
    return yield* Effect.fail(refused);
  if (service.serviceTypeId === undefined || service.serviceTypeId.length === 0)
    return yield* Effect.fail(refused);
  const definition = yield* plugins.value
    .loadServiceType(service.serviceTypeId)
    .pipe(Effect.mapError(refusal));
  if (definition.id !== service.serviceTypeId) return yield* Effect.fail(refused);
  const factoryTask = definition.toolingForConnection?.(owner, service.connection)[input.name];
  if (factoryTask === undefined) return yield* Effect.fail(refused);
  const generated = { service: owner, ...factoryTask };
  const { env: _env, vars: _vars, dir: _dir, service: _service, ...currentTask } = input.task;
  const base =
    input.currentLandofile === undefined
      ? input.task
      : (applyToolingDefaults({ [input.name]: currentTask }, input.currentLandofile.toolingDefaults)?.[
          input.name
        ] ?? {});
  const task = { ...base, ...generated, env: { ...base.env, ...generated.env } };
  const sites = input.sites.filter((site) => {
    const [field, key] = site.path;
    if (field === "env")
      return generated.env === undefined || (key !== undefined && !Object.hasOwn(generated.env, key));
    return field === undefined || !Object.hasOwn(generated, field);
  });
  return { task, sites };
});
