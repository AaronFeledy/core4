import { AppId } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

import { ROUTE_FILE_PREFIX, ROUTE_FILE_SUFFIX, TRAEFIK_CONTAINER_CERTIFICATE_DIR } from "./proxy-paths.ts";
import { OWNER_ROUTE_KEY_PATTERN, isRouteFileName } from "./route-file-metadata.ts";

const Router = Schema.Struct({
  rule: Schema.String,
  entryPoints: Schema.Array(Schema.Literals(["web", "websecure"])),
  priority: Schema.Int,
  service: Schema.String,
  tls: Schema.optionalKey(Schema.Struct({})),
  middlewares: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Middleware = Schema.Union([
  Schema.Struct({ stripPrefix: Schema.Struct({ prefixes: Schema.Tuple([Schema.String]) }) }),
  Schema.Struct({ addPrefix: Schema.Struct({ prefix: Schema.String }) }),
  Schema.Struct({
    headers: Schema.Struct({ customRequestHeaders: Schema.Record(Schema.String, Schema.String) }),
  }),
  Schema.Struct({
    headers: Schema.Struct({ customResponseHeaders: Schema.Record(Schema.String, Schema.String) }),
  }),
  Schema.Struct({
    redirectRegex: Schema.Struct({
      regex: Schema.Literal("^.*$"),
      replacement: Schema.String,
      permanent: Schema.optionalKey(Schema.Boolean),
    }),
  }),
]);
const LegacyConfig = Schema.Struct({
  http: Schema.Struct({
    routers: Schema.NullOr(Schema.Record(Schema.String, Router)),
    services: Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          loadBalancer: Schema.Struct({ servers: Schema.Tuple([Schema.Struct({ url: Schema.String })]) }),
        }),
      ),
    ),
    middlewares: Schema.optionalKey(Schema.Record(Schema.String, Middleware)),
  }),
  tls: Schema.optionalKey(
    Schema.Struct({
      certificates: Schema.Tuple([Schema.Struct({ certFile: Schema.String, keyFile: Schema.String })]),
    }),
  ),
});
const decode = Schema.decodeUnknownOption(LegacyConfig, { onExcessProperty: "error" });
const jsonString = '"(?:[^"\\\\]|\\\\.)*"';
const rulePattern = new RegExp(
  `^(?:Host|HostRegexp)\\(${jsonString}\\)(?: && PathPrefix\\(${jsonString}\\))?$`,
  "u",
);

// The pre-owner writer emitted this exact serialization, including unquoted
// router/service names and JSON middleware values. Rebuilding it rejects comments,
// extra keys, aliases, duplicate keys, and edits outside that writer's grammar.
export const recognizeLegacyRouteFile = (name: string, content: string) => {
  if (!isRouteFileName(name)) return undefined;
  const encoded = name.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length);
  let app: string;
  try {
    app = decodeURIComponent(encoded);
  } catch (cause) {
    if (!(cause instanceof URIError)) throw cause;
    return undefined;
  }
  if (
    !Schema.is(AppId)(app) ||
    app.trim().length === 0 ||
    /[\p{Cc}]/u.test(app) ||
    OWNER_ROUTE_KEY_PATTERN.test(app.toLowerCase()) ||
    encodeURIComponent(app) !== encoded
  )
    return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return undefined;
  }
  const config = Option.getOrUndefined(decode(parsed));
  if (config === undefined) return undefined;
  const prefix = `route-${encoded}-`;
  const routers = Object.entries(config.http.routers ?? {});
  const services = Object.entries(config.http.services ?? {});
  const middlewares = Object.entries(config.http.middlewares ?? {});
  const lines = ["http:", "  routers:"];
  const usedMiddleware = new Set<string>();
  for (const [index, [serviceName, service]] of services.entries()) {
    if (
      serviceName !== `${prefix}${index}` ||
      !/^https?:\/\/[^\s]+:\d+$/u.test(service.loadBalancer.servers[0].url)
    )
      return undefined;
    const group = routers.filter(([, router]) => router.service === serviceName);
    if (group.length < 1 || group.length > 2) return undefined;
    const first = group[0]?.[1];
    if (first === undefined) return undefined;
    if (
      group.some(
        ([, router]) =>
          router.rule !== first.rule ||
          router.priority !== first.priority ||
          JSON.stringify(router.middlewares) !== JSON.stringify(first.middlewares),
      )
    )
      return undefined;
    for (const [name, router] of group) {
      const scheme =
        name === `${serviceName}-http` ? "http" : name === `${serviceName}-https` ? "https" : undefined;
      if (
        scheme === undefined ||
        !rulePattern.test(router.rule) ||
        router.entryPoints.length !== 1 ||
        router.entryPoints[0] !== (scheme === "https" ? "websecure" : "web") ||
        (router.tls !== undefined) !== (scheme === "https")
      )
        return undefined;
      lines.push(
        `    ${name}:`,
        `      rule: ${JSON.stringify(router.rule)}`,
        `      entryPoints: [${router.entryPoints[0]}]`,
        `      priority: ${router.priority}`,
        `      service: ${serviceName}`,
      );
      if (scheme === "https") lines.push("      tls: {}");
      if (router.middlewares !== undefined) {
        if (router.middlewares.length === 0) return undefined;
        lines.push("      middlewares:");
        for (const [filterIndex, middlewareName] of router.middlewares.entries()) {
          const middleware = config.http.middlewares?.[middlewareName];
          if (middleware === undefined) return undefined;
          let type: string;
          switch (true) {
            case "stripPrefix" in middleware:
              type = "stripPrefix";
              break;
            case "addPrefix" in middleware:
              type = "addPrefix";
              break;
            case "redirectRegex" in middleware:
              type = "redirect";
              break;
            default:
              type = "customRequestHeaders" in middleware.headers ? "requestHeader" : "responseHeader";
          }
          if (middlewareName !== `${serviceName}-f${filterIndex}-${type}`) return undefined;
          if (
            "headers" in middleware &&
            Object.values(middleware.headers).some((headers) => Object.keys(headers).length !== 1)
          )
            return undefined;
          usedMiddleware.add(middlewareName);
          lines.push(`        - ${JSON.stringify(middlewareName)}`);
        }
      }
    }
  }
  if (
    routers.some(([, router]) => !(router.service in (config.http.services ?? {}))) ||
    usedMiddleware.size !== middlewares.length
  )
    return undefined;
  lines.push("  services:");
  for (const [name, service] of services)
    lines.push(
      `    ${name}:`,
      "      loadBalancer:",
      "        servers:",
      `          - url: ${service.loadBalancer.servers[0].url}`,
    );
  if (middlewares.length > 0) {
    lines.push("  middlewares:");
    for (const [name, middleware] of middlewares)
      lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(middleware)}`);
  }
  const certificate = config.tls?.certificates[0];
  if (certificate !== undefined) {
    if (
      certificate.certFile !== `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.crt` ||
      certificate.keyFile !== `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.key`
    )
      return undefined;
    lines.push(
      "tls:",
      "  certificates:",
      `    - certFile: ${certificate.certFile}`,
      `      keyFile: ${certificate.keyFile}`,
    );
  }
  lines.push("");
  return lines.join("\n") === content
    ? { app, encoded, hasCertificate: certificate !== undefined }
    : undefined;
};
