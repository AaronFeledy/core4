import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppSelector, ProviderError } from "@lando/sdk/services";
import { Effect, Redacted, Schema } from "effect";
import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "./labels.ts";

const Containers = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
);
const Container = Schema.Struct({
  Config: Schema.Struct({ Env: Schema.NullOr(Schema.Array(Schema.String)) }),
});

// Container environments are immutable; a fresh list evicts removed identities for this provider/app.
const environments = new Map<
  string,
  { readonly app: string; readonly provider: string; readonly env: ReadonlyArray<string> }
>();

export const readAppEnvironment = Effect.fn("RuntimeProvider.readAppEnvironment")(function* (
  target: AppSelector,
  names: Readonly<Record<string, ReadonlyArray<string>>>,
  options: { readonly api: EngineHttpApi | undefined; readonly ctx: ProviderErrorContext },
): Effect.fn.Return<ReadonlyArray<Redacted.Redacted<string>>, ProviderError> {
  const { ctx } = options;
  const request = options.api?.request;
  if (request === undefined) return yield* Effect.fail(missingApi(ctx, "readAppEnvironment"));
  const malformed = () =>
    new ProviderInternalError({
      providerId: ctx.providerId,
      operation: "readAppEnvironment",
      message: "Container engine returned invalid app environment metadata.",
      remediation: ctx.remediation,
    });
  const get = (path: EngineHttpRequest["path"]) =>
    request({ method: "GET", path }).pipe(
      Effect.mapError(
        () =>
          new ProviderUnavailableError({
            providerId: ctx.providerId,
            operation: "readAppEnvironment",
            message: "Could not read app environment from the container engine.",
            remediation: ctx.remediation,
          }),
      ),
      Effect.flatMap((response): Effect.Effect<unknown, ProviderError> => {
        if (response.status === 404) return Effect.succeed(undefined);
        if (response.status < 200 || response.status >= 300)
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: ctx.providerId,
              operation: "readAppEnvironment",
              message: `Container engine app environment read failed with HTTP ${response.status}.`,
              remediation: ctx.remediation,
            }),
          );
        return Effect.try({ try: (): unknown => JSON.parse(response.body), catch: malformed });
      }),
    );
  const query = new URLSearchParams({
    all: "true",
    filters: JSON.stringify({ label: [`${APP_LABEL}=${target.app}`] }),
  });
  const body = yield* get(`/containers/json?${query}`);
  const containers = yield* Schema.decodeUnknownEffect(Containers)(body).pipe(Effect.mapError(malformed));
  const current = new Set(
    containers
      .filter((container) => container.Labels?.[APP_LABEL] === target.app)
      .map((container) => container.Id),
  );
  for (const [id, entry] of environments) {
    if (entry.app === target.app && entry.provider === ctx.providerId && !current.has(id))
      environments.delete(id);
  }
  const values = new Set<string>();
  for (const container of containers) {
    const labels = container.Labels;
    if (labels?.[APP_LABEL] !== target.app) continue;
    if (target.plan !== undefined && labels[APP_ROOT_LABEL] !== target.plan.root) continue;
    const service = labels[SERVICE_LABEL];
    const requested = service === undefined || !Object.hasOwn(names, service) ? undefined : names[service];
    if (requested === undefined || requested.length === 0) continue;
    let cached = environments.get(container.Id);
    if (cached === undefined) {
      const inspected = yield* get(`/containers/${encodeURIComponent(container.Id)}/json`);
      if (inspected === undefined) continue;
      const config = yield* Schema.decodeUnknownEffect(Container)(inspected).pipe(Effect.mapError(malformed));
      cached = { app: target.app, provider: ctx.providerId, env: config.Config.Env ?? [] };
      environments.set(container.Id, cached);
    }
    const keys = new Set(requested);
    for (const entry of cached.env) {
      const split = entry.indexOf("=");
      if (split > 0 && keys.has(entry.slice(0, split)) && entry.length > split + 1)
        values.add(entry.slice(split + 1));
    }
  }
  return [...values].map((value) => Redacted.make(value));
});
