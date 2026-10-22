import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { HOST_PROXY_CREDENTIAL_ENV_NAMES } from "@lando/sdk/secrets";
import type { AppSelector, ProviderError } from "@lando/sdk/services";
import { Effect, Redacted, Schema } from "effect";
import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { APP_LABEL, APP_ROOT_LABEL, HOST_PROXY_SESSION_LABEL, SECRET_ENVIRONMENT_LABEL } from "./labels.ts";

const Containers = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    Labels: Schema.Record(Schema.String, Schema.String),
  }),
);
const Container = Schema.Struct({
  Config: Schema.Struct({ Env: Schema.NullOr(Schema.Array(Schema.String)) }),
});

export const readAppSecrets = Effect.fn("RuntimeProvider.readAppSecrets")(function* (
  target: AppSelector,
  options: { readonly api: EngineHttpApi | undefined; readonly ctx: ProviderErrorContext },
): Effect.fn.Return<ReadonlyArray<Redacted.Redacted<string>>, ProviderError> {
  const { ctx } = options;
  const request = options.api?.request;
  if (request === undefined) return yield* Effect.fail(missingApi(ctx, "readAppSecrets"));
  const malformed = () =>
    new ProviderInternalError({
      providerId: ctx.providerId,
      operation: "readAppSecrets",
      message: "Container engine returned invalid app secret metadata.",
      remediation: ctx.remediation,
    });
  const get = (path: EngineHttpRequest["path"]) =>
    request({ method: "GET", path }).pipe(
      Effect.mapError(
        () =>
          new ProviderUnavailableError({
            providerId: ctx.providerId,
            operation: "readAppSecrets",
            message: "Could not read app secrets from the container engine.",
            remediation: ctx.remediation,
          }),
      ),
      Effect.flatMap((response): Effect.Effect<unknown, ProviderError> => {
        if (response.status === 404) return Effect.succeed(undefined);
        if (response.status < 200 || response.status >= 300)
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: ctx.providerId,
              operation: "readAppSecrets",
              message: `Container engine app secret read failed with HTTP ${response.status}.`,
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
  const values = new Set<string>();
  for (const container of containers) {
    const labels = container.Labels;
    if (labels[APP_LABEL] !== target.app) continue;
    if (target.plan !== undefined && labels[APP_ROOT_LABEL] !== target.plan.root) continue;
    if (labels[SECRET_ENVIRONMENT_LABEL] === undefined && labels[HOST_PROXY_SESSION_LABEL] === undefined)
      continue;
    const inspected = yield* get(`/containers/${encodeURIComponent(container.Id)}/json`);
    if (inspected === undefined) continue;
    const config = yield* Schema.decodeUnknownEffect(Container)(inspected).pipe(Effect.mapError(malformed));
    const keys = new Set([
      ...(labels[SECRET_ENVIRONMENT_LABEL]?.split(",") ?? []),
      ...HOST_PROXY_CREDENTIAL_ENV_NAMES,
    ]);
    for (const entry of config.Config.Env ?? []) {
      const split = entry.indexOf("=");
      if (split > 0 && keys.has(entry.slice(0, split)) && entry.length > split + 1)
        values.add(entry.slice(split + 1));
    }
  }
  return [...values].map((value) => Redacted.make(value));
});
