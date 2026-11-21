import { compiledValueError, siteExpression } from "@lando/landofile/compiled-sites";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type ExpressionContext, expressionScopeMembers } from "@lando/sdk/expressions";
import { ServiceConfig, type ValidationIssuePath } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { type DeferredExpressionSites, materializeServiceScopeSites } from "./landofile-scopes.ts";

export const materializeServicePort = Effect.fnUntraced(function* (input: {
  readonly service: ServiceConfig;
  readonly serviceType: ServiceType;
  readonly sites: DeferredExpressionSites;
  readonly context: ExpressionContext;
  readonly pathPrefix: ValidationIssuePath;
  readonly landofilePath: string;
}) {
  const { service, serviceType, context, pathPrefix, landofilePath } = input;
  const sites = input.sites.filter((site) =>
    expressionScopeMembers(site.template, "service").members.has("port"),
  );
  const first = sites[0];
  if (first === undefined) return service;
  const { port, via, framework, type } = service;
  const select = serviceType.plannedPort;
  const planned = select?.({
    ...(port === undefined ? {} : { port }),
    ...(via === undefined ? {} : { via }),
    ...(framework === undefined ? {} : { framework }),
    ...(type === undefined ? {} : { type }),
  });
  if (planned === undefined) {
    return yield* Effect.fail(
      new ConfigExpressionError({
        message: `Service type ${serviceType.id} declares no planned listen port for service.port in this configuration.`,
        path: first.path,
        source: first.source,
        expression: siteExpression(first, service, pathPrefix.length),
        filePath: "file" in first.source ? first.source.file : landofilePath,
        remediation:
          select === undefined
            ? "Use a literal port or choose a service type that declares a planned listen port."
            : "Choose a configuration with a listener and set port: if needed, or remove the service.port expression.",
      }),
    );
  }
  const { document } = yield* materializeServiceScopeSites({
    value: service,
    deferredSites: sites,
    selfPort: planned,
    context,
    pathPrefix,
    landofilePath,
  });
  return yield* Schema.decodeUnknownEffect(Schema.toType(ServiceConfig))(document).pipe(
    mapFailures((cause) =>
      compiledValueError(cause, { filePath: landofilePath, pendingSites: sites, pathPrefix }),
    ),
  );
});
