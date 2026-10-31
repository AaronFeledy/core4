import { Effect, Schema } from "effect";

import { GlobalAppError, type StateStoreError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";

import type { PendingGlobalServiceContribution } from "../services/global-services.ts";

const ContributionPolicy = Schema.Struct({
  defaultEnabled: Schema.Boolean,
  enabled: Schema.optionalKey(Schema.Boolean),
});

const PluginPolicy = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  contributions: Schema.Record(Schema.String, ContributionPolicy),
});

/** Owned preferences survive plugin updates without claiming another plugin's service ids. */
export const GlobalPolicy = Schema.Struct({
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  plugins: Schema.Record(Schema.String, PluginPolicy),
});
export type GlobalPolicy = typeof GlobalPolicy.Type;
export type GlobalPolicyChange = {
  readonly selectors: ReadonlyArray<string>;
  readonly all?: boolean;
  readonly enabled: boolean;
};

export const emptyGlobalPolicy = (): GlobalPolicy => ({ revision: 0, plugins: {} });

const policyError = (cause: StateStoreError): GlobalAppError =>
  new GlobalAppError({
    operation: "policy",
    message: "Unable to read or update global service policy.",
    remediation: `Repair the policy document or permissions at ${cause.path ?? "global.config.yml"}, then retry.`,
    cause,
  });

const selectionError = (message: string): GlobalAppError =>
  new GlobalAppError({
    operation: "policy",
    message,
    remediation:
      "Run `lando global:list` and select an exact contribution id or plugin package, or use --all.",
  });

export const globalPolicyBucket = Effect.fn("GlobalApp.policyBucket")(function* () {
  const store = yield* StateStore;
  return yield* store
    .open({
      root: "userConf",
      key: "global.config.yml",
      schema: GlobalPolicy,
      version: 1,
      codec: {
        encode: (policy) => Bun.YAML.stringify(policy),
        decode: (raw) =>
          Schema.decodeUnknownSync(GlobalPolicy, { onExcessProperty: "error" })(
            Bun.YAML.parse(new TextDecoder().decode(raw)),
          ),
      },
      lock: "advisory",
      onCorrupt: "fail",
      default: emptyGlobalPolicy(),
    })
    .pipe(Effect.mapError(policyError));
});

export const readGlobalPolicy = Effect.fn("GlobalApp.readPolicy")(function* () {
  const bucket = yield* globalPolicyBucket();
  if (!(yield* bucket.exists.pipe(Effect.mapError(policyError)))) return emptyGlobalPolicy();
  return (yield* bucket.get.pipe(Effect.mapError(policyError))) ?? emptyGlobalPolicy();
});

export const globalContributionPolicy = (
  entry: PendingGlobalServiceContribution,
  policy: GlobalPolicy,
): { readonly enabled: boolean; readonly source: "default" | "plugin" | "contribution" } => {
  const owner = Object.hasOwn(policy.plugins, entry.plugin) ? policy.plugins[entry.plugin] : undefined;
  const contribution =
    owner !== undefined && Object.hasOwn(owner.contributions, entry.contribution.id)
      ? owner.contributions[entry.contribution.id]
      : undefined;
  if (contribution?.enabled !== undefined) return { enabled: contribution.enabled, source: "contribution" };
  if (owner?.enabled !== undefined) return { enabled: owner.enabled, source: "plugin" };
  return {
    enabled: contribution?.defaultEnabled ?? entry.contribution.enabledByDefault !== false,
    source: "default",
  };
};

interface MutablePluginPolicy {
  enabled?: boolean;
  contributions: Map<string, typeof ContributionPolicy.Type>;
}

const sortedRecord = <A>(entries: Iterable<readonly [string, A]>): Record<string, A> =>
  Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));

const policyPlugins = (plugins: ReadonlyMap<string, MutablePluginPolicy>): GlobalPolicy["plugins"] =>
  sortedRecord(
    [...plugins].map(
      ([plugin, value]) =>
        [
          plugin,
          {
            ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
            contributions: sortedRecord(value.contributions),
          },
        ] as const,
    ),
  );

/** Prepare without IO; callers can validate this immutable revision before committing it. */
export const prepareGlobalPolicy = Effect.fnUntraced(function* (
  policy: GlobalPolicy,
  contributions: ReadonlyArray<PendingGlobalServiceContribution>,
  change?: GlobalPolicyChange,
) {
  const plugins = new Map<string, MutablePluginPolicy>(
    Object.entries(policy.plugins).map(([plugin, value]) => [
      plugin,
      {
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
        contributions: new Map(Object.entries(value.contributions)),
      },
    ]),
  );
  for (const entry of contributions) {
    const owner = plugins.get(entry.plugin) ?? { contributions: new Map() };
    if (!owner.contributions.has(entry.contribution.id)) {
      owner.contributions.set(entry.contribution.id, {
        defaultEnabled: entry.contribution.enabledByDefault !== false,
      });
    }
    plugins.set(entry.plugin, owner);
  }

  const selectedPlugins = new Set<string>();
  const selectedEntries = new Map<string, { readonly plugin: string; readonly id: string }>();
  const entriesFor = (plugin: string) =>
    [...(plugins.get(plugin)?.contributions.keys() ?? [])].map((id) => ({ plugin, id }));
  const keyOf = (entry: { readonly plugin: string; readonly id: string }) => `${entry.plugin}\0${entry.id}`;
  if (change !== undefined) {
    const selectors = [...new Set(change.selectors)];
    if ((change.all === true && selectors.length > 0) || (change.all !== true && selectors.length === 0)) {
      return yield* Effect.fail(
        selectionError("Choose contribution/plugin selectors or --all, but not both."),
      );
    }
    if (change.all === true) {
      for (const plugin of plugins.keys()) selectedPlugins.add(plugin);
    } else {
      for (const selector of selectors) {
        if (selector.trim() === "")
          return yield* Effect.fail(selectionError("A global service selector cannot be empty."));
        const packageEntries = plugins.has(selector) ? entriesFor(selector) : [];
        const idEntries = [...plugins.keys()].flatMap(entriesFor).filter((entry) => entry.id === selector);
        if (idEntries.length > 1)
          return yield* Effect.fail(
            selectionError(
              `Contribution id ${selector} has retained policies under multiple plugins; select its owning package.`,
            ),
          );
        if (plugins.has(selector)) {
          if (
            idEntries.length > 0 &&
            (packageEntries.length !== idEntries.length ||
              packageEntries.some(
                (entry) => !idEntries.some((candidate) => keyOf(entry) === keyOf(candidate)),
              ))
          ) {
            return yield* Effect.fail(
              selectionError(`Global selection ${selector} matches a plugin and a different contribution.`),
            );
          }
          selectedPlugins.add(selector);
        } else if (idEntries.length === 1) {
          const entry = idEntries[0];
          if (entry !== undefined) selectedEntries.set(keyOf(entry), entry);
        } else
          return yield* Effect.fail(
            selectionError(`No current contribution or retained plugin policy matches ${selector}.`),
          );
      }
    }
    for (const plugin of selectedPlugins) {
      const owner = plugins.get(plugin);
      if (owner === undefined) continue;
      owner.enabled = change.enabled;
      for (const [id, value] of owner.contributions) {
        owner.contributions.set(id, { defaultEnabled: value.defaultEnabled });
        selectedEntries.set(keyOf({ plugin, id }), { plugin, id });
      }
    }
    for (const entry of selectedEntries.values()) {
      if (selectedPlugins.has(entry.plugin)) continue;
      const owner = plugins.get(entry.plugin);
      const previous = owner?.contributions.get(entry.id);
      if (owner !== undefined && previous !== undefined)
        owner.contributions.set(entry.id, { ...previous, enabled: change.enabled });
    }
  }
  const nextPlugins = policyPlugins(plugins);
  const changed =
    JSON.stringify(nextPlugins) !==
    JSON.stringify(
      policyPlugins(
        new Map(
          Object.entries(policy.plugins).map(([plugin, value]) => [
            plugin,
            { ...value, contributions: new Map(Object.entries(value.contributions)) },
          ]),
        ),
      ),
    );
  if (changed && policy.revision === Number.MAX_SAFE_INTEGER)
    return yield* Effect.fail(
      new GlobalAppError({
        operation: "policy",
        message: "Global service policy revision is exhausted.",
        remediation: "Repair the policy revision before applying another policy change.",
      }),
    );
  const ids = contributions
    .filter((entry) => selectedEntries.has(keyOf({ plugin: entry.plugin, id: entry.contribution.id })))
    .map((entry) => entry.contribution.id)
    .sort();
  return {
    policy: { revision: policy.revision + (changed ? 1 : 0), plugins: nextPlugins } satisfies GlobalPolicy,
    ids: [...new Set(ids)],
    selections: [...selectedEntries.values()].sort(
      (left, right) => left.plugin.localeCompare(right.plugin) || left.id.localeCompare(right.id),
    ),
    plugins: [...selectedPlugins].sort(),
    changed,
  };
});

/** Commit only the policy revision that was preflighted, never a silently merged newer candidate. */
export const commitGlobalPolicy = Effect.fn("GlobalApp.commitPolicy")(function* (
  expectedRevision: number,
  next: GlobalPolicy,
) {
  if (next.revision !== expectedRevision && next.revision !== expectedRevision + 1)
    return yield* Effect.fail(
      new GlobalAppError({
        operation: "policy",
        message: "The candidate global policy has an invalid revision.",
        remediation: "Prepare and validate a fresh policy candidate before committing it.",
      }),
    );
  const bucket = yield* globalPolicyBucket();
  const current = (yield* bucket.get.pipe(Effect.mapError(policyError))) ?? emptyGlobalPolicy();
  if (current.revision === expectedRevision && JSON.stringify(current) === JSON.stringify(next))
    return current;
  if (next.revision !== expectedRevision + 1)
    return yield* Effect.fail(
      new GlobalAppError({
        operation: "policy",
        message: "A changed global policy must advance its preflight revision exactly once.",
        remediation: "Prepare and validate a fresh policy candidate before committing it.",
      }),
    );
  const result = yield* bucket
    .modify<{ readonly committed: boolean; readonly policy: GlobalPolicy }>((stored) => {
      const actual = stored ?? emptyGlobalPolicy();
      if (actual.revision !== expectedRevision)
        return [{ committed: false as const, policy: actual }, actual] as const;
      return [{ committed: true as const, policy: next }, next] as const;
    })
    .pipe(Effect.mapError(policyError));
  if (!result.committed)
    return yield* Effect.fail(
      new GlobalAppError({
        operation: "policy",
        message: `Global service policy changed from revision ${expectedRevision} to ${result.policy.revision} during validation.`,
        remediation: "Retry the command so its dependency and capability checks use the current policy.",
      }),
    );
  return result.policy;
});
