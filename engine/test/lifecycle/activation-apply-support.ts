import { type AppPlan, CertificateName, ServiceName } from "@lando/sdk/schema";
import { EnvironmentValueResolver, type EnvironmentValueResolverSession } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { prepareProvider } from "../../src/providers/prepared.ts";
import { service } from "./service-certificates-support.ts";

export const session: EnvironmentValueResolverSession = {
  resolveEnvironment: () => Effect.succeed({ TOKEN: "resolved" }),
};
export const unusedResolver = EnvironmentValueResolver.of({
  openSession: () => Effect.die("Unexpected session"),
});

export const resolvingProvider = (
  calls: string[],
  use: (environment: Readonly<Record<string, string>>) => void,
) =>
  prepareProvider({
    ...TestRuntimeProvider,
    apply: (plan, options) =>
      Effect.gen(function* () {
        calls.push("apply");
        const web = plan.services[ServiceName.make("web")];
        if (web === undefined || options.resolveServiceEnvironment === undefined)
          return yield* Effect.die("Missing resolver");
        use(yield* options.resolveServiceEnvironment(web));
        return { changed: true };
      }),
  });

export const refusalCases: readonly { readonly name: string; readonly change: (plan: AppPlan) => AppPlan }[] =
  [
    { name: "owner", change: (plan) => ({ ...plan, identity: { appRoot: plan.root, ownerKey: "other" } }) },
    {
      name: "missing service entry",
      change: (plan) => ({
        ...plan,
        services: {
          ...plan.services,
          [ServiceName.make("unprepared")]: {
            ...service("unprepared"),
            certs: { caId: "fake", cn: CertificateName.make("web"), sans: [] },
          },
        },
      }),
    },
    ...[
      { name: "authority", request: { caId: "other" } },
      { name: "common name", request: { cn: CertificateName.make("other") } },
      { name: "SAN set", request: { sans: [CertificateName.make("other")] } },
    ].map(({ name, request }) => ({
      name,
      change: (plan: AppPlan) => ({
        ...plan,
        services: Object.fromEntries(
          Object.entries(plan.services).map(([name, service]) => [
            name,
            service.certs === undefined ? service : { ...service, certs: { ...service.certs, ...request } },
          ]),
        ),
      }),
    })),
    ...[".crt", ".key"].map((suffix) => ({
      name: `missing ${suffix} bind`,
      change: (plan: AppPlan) => ({
        ...plan,
        services: Object.fromEntries(
          Object.entries(plan.services).map(([name, service]) => [
            name,
            {
              ...service,
              mounts: service.mounts.filter(
                (mount) => mount.type !== "bind" || !mount.source.endsWith(suffix),
              ),
            },
          ]),
        ),
      }),
    })),
  ];
