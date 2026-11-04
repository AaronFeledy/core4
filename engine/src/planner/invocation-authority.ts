import {
  InvocationProgram,
  type InvocationSite,
  authoredInvocationSites,
  compileInvocationSites,
  compiledValueError,
} from "@lando/landofile/compiled-sites";
import type {
  AppPlan,
  EventsPlan,
  HostEvents,
  LandofileShape,
  ServiceScopedLandofile,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  compileEffectiveTooling,
  connectionClientsForPlan,
  effectiveToolingForPlan,
} from "./effective-tooling.ts";
import { serviceCredsScopeForPlan, serviceScopeContext } from "./landofile-scopes.ts";

const KEY = "@lando/core/invocation-authority";
const Authority = Schema.Struct({
  sites: InvocationProgram,
});
export const invocationAuthorityForPlan = (plan: AppPlan) => {
  const value = plan.extensions[KEY];
  return value === undefined ? undefined : Schema.decodeUnknownSync(Authority)(value);
};
export const attachInvocationAuthority = <Plan extends AppPlan>(
  plan: Plan,
  authority: typeof Authority.Type,
): Plan => ({
  ...plan,
  extensions: { ...plan.extensions, [KEY]: Authority.make(authority) },
});

export const compilePlanInvocationSites = Effect.fnUntraced(function* (input: {
  readonly sites: InvocationProgram;
  readonly hostEvents: HostEvents | undefined;
  readonly env: Readonly<Record<string, string>>;
}) {
  const authored =
    input.hostEvents === undefined
      ? []
      : yield* Effect.try({
          try: () => authoredInvocationSites(input.hostEvents, "<host-events>"),
          catch: (cause) => compiledValueError(cause, { filePath: "<host-events>", pendingSites: [] }),
        });
  const hostSites = yield* compileInvocationSites(authored, { env: input.env }, input.hostEvents);
  return [...input.sites, ...hostSites.map((site) => ({ ...site, path: ["hostEvents", ...site.path] }))];
});

export const attachCompiledInvocationPlan = <Plan extends AppPlan>(
  plan: Plan,
  sites: InvocationProgram,
  events: EventsPlan,
): Plan => attachInvocationAuthority({ ...plan, events }, { sites });

export const sitesUnder = (
  sites: InvocationProgram,
  prefix: readonly (string | number)[],
): InvocationProgram =>
  sites
    .filter((site) => prefix.every((part, index) => site.path[index] === part))
    .map((site) => ({ ...site, path: site.path.slice(prefix.length) }));

export const effectiveInvocationSites = (input: {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults">;
  readonly taskNames: readonly string[];
  readonly tasksBeforeDefaults?: Readonly<NonNullable<LandofileShape["tooling"]>>;
  readonly sites: InvocationProgram;
}): InvocationProgram => {
  const sites: InvocationSite[] = input.sites.filter((site) => site.path[0] === "events");
  for (const name of input.taskNames) {
    sites.push(
      ...sitesUnder(input.sites, ["tooling", name]).map((site) => ({
        ...site,
        path: ["tooling", name, ...site.path],
      })),
    );
    const task = (input.tasksBeforeDefaults ?? input.landofile.tooling)?.[name];
    for (const site of sitesUnder(input.sites, ["toolingDefaults"])) {
      const [field, key] = site.path;
      const winner =
        field === "env" || field === "vars"
          ? key !== undefined && Object.hasOwn(task?.[field] ?? {}, key)
          : field !== undefined && Object.hasOwn(task ?? {}, field);
      if (!winner) sites.push({ ...site, path: ["tooling", name, ...site.path] });
    }
  }
  return sites;
};

export const invocationToolingForPlan = Effect.fnUntraced(function* (
  compiled: ServiceScopedLandofile,
  plan: AppPlan,
  defaultDomain: string,
) {
  const landofile = compiled.document;
  const authored = compileEffectiveTooling({ landofile, services: [] });
  const names = new Set(Object.keys(authored));
  const refreshed = new Set([...names, ...Object.keys(connectionClientsForPlan(plan))]);
  const sites = effectiveInvocationSites({
    landofile,
    taskNames: [...refreshed],
    sites: yield* compileInvocationSites(
      compiled.pendingSites,
      serviceScopeContext({
        landofile,
        context: compiled.context,
        appSlug: plan.slug,
        defaultDomain,
        services: serviceCredsScopeForPlan(plan),
      }),
      landofile,
    ),
  });
  return {
    tooling: { ...effectiveToolingForPlan(plan), ...authored },
    sites: [
      ...(invocationAuthorityForPlan(plan)?.sites ?? []).filter(
        (site) => site.path[0] === "tooling" && !refreshed.has(String(site.path[1])),
      ),
      ...sites,
    ],
  };
});
