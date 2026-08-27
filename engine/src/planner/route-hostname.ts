import { Effect, Either } from "effect";

import { ConfigExpressionError } from "@lando/sdk/errors";
import { evaluateTemplateEither, parseExpressionEither } from "@lando/sdk/expressions";

export interface RouteHostnameExpressionInput {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly routeIndex: number;
  readonly appName: string;
  readonly appSlug: string;
  readonly defaultDomain: string;
}

const hostnameYamlPath = (serviceName: string, routeIndex: number): string =>
  `services.${serviceName}.routes.${routeIndex}.hostname`;

const expressionError = (
  hostname: string,
  input: RouteHostnameExpressionInput,
  message: string,
): ConfigExpressionError =>
  new ConfigExpressionError({
    message,
    expression: hostname,
    path: hostnameYamlPath(input.serviceName, input.routeIndex),
    filePath: `${input.appRoot}/.lando.yml`,
    remediation: "Fix the hostname expression, or set proxy.defaultDomain in global config.",
  });

export const evaluateRouteHostname = (
  hostname: string,
  input: RouteHostnameExpressionInput,
): Effect.Effect<string, ConfigExpressionError> => {
  if (!hostname.includes("{{")) return Effect.succeed(hostname);

  const filePath = `${input.appRoot}/.lando.yml`;
  const parsed = parseExpressionEither(hostname, { filePath });
  if (Either.isLeft(parsed)) {
    return Effect.fail(expressionError(hostname, input, parsed.left.message));
  }

  const evaluated = evaluateTemplateEither(
    parsed.right,
    {
      app: { name: input.appName, slug: input.appSlug },
      proxy: { defaultDomain: input.defaultDomain },
    },
    { filePath },
  );
  if (Either.isLeft(evaluated)) {
    return Effect.fail(expressionError(hostname, input, evaluated.left.message));
  }
  if (typeof evaluated.right !== "string" || evaluated.right.length === 0) {
    return Effect.fail(
      expressionError(hostname, input, "Hostname expression did not evaluate to a hostname string."),
    );
  }
  return Effect.succeed(evaluated.right);
};
