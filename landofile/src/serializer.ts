export * from "@lando/sdk/landofile";

import { isEnvironmentBinding } from "@lando/sdk/expressions";
import { LandofileEmitError, emitLandofileYaml, isPlainRecord } from "@lando/sdk/landofile";
import { type CompiledLandofile, type ValidationIssuePath, routeUrlPartFact } from "@lando/sdk/schema";
import { literalSource, templateSource } from "./expression-source.ts";

export const compiledLandofileSource = (compiled: CompiledLandofile): Record<string, unknown> => {
  const sites = new Map(compiled.pendingSites.map((site) => [JSON.stringify(site.path), site]));
  const visit = (value: unknown, path: ValidationIssuePath): unknown => {
    const site = sites.get(JSON.stringify(path));
    if (site !== undefined) return templateSource(site.template);
    if (isEnvironmentBinding(value)) {
      switch (value._tag) {
        case "SecretRef":
          return `\${secret:${value.reference}}`;
        case "BoundText":
          return `{{ concat(${value.parts
            .map((part) =>
              typeof part === "string"
                ? JSON.stringify(part)
                : part.encoding === "raw"
                  ? `secrets[${JSON.stringify(part.reference)}]`
                  : `url.encodeComponent(secrets[${JSON.stringify(part.reference)}])`,
            )
            .join(", ")}) }}`;
        case "RouteText":
          return `{{ concat(${value.parts
            .map((part) => {
              if (typeof part === "string") return JSON.stringify(part);
              const expression = `services[${JSON.stringify(part.service)}].${routeUrlPartFact(part)}`;
              return part.encoding === "raw" ? expression : `url.encodeComponent(${expression})`;
            })
            .join(", ")}) }}`;
        default:
          return value satisfies never;
      }
    }
    if (typeof value === "string") return path[0] === "recipe" ? value : literalSource(value);
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
    if (isPlainRecord(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]),
      );
    return value;
  };
  const source = visit(compiled.document, []);
  if (!isPlainRecord(source))
    throw new LandofileEmitError({ message: "Compiled Landofile source must be a mapping." });
  return source;
};

export const emitCompiledLandofileYaml = (compiled: CompiledLandofile): string =>
  emitLandofileYaml(compiledLandofileSource(compiled));
