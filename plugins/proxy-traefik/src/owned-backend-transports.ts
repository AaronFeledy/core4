import type { AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";

import { decodeObservedTransportBody, observedTransportReference } from "./backend-transport.ts";
import { routeFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { parseRouteFileMetadata } from "./route-file-metadata.ts";
import { routeNamespace } from "./routing.ts";

const OwnedDynamicConfig = Schema.Struct({
  http: Schema.Struct({
    serversTransports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const decodeOwnedDynamicConfig = Schema.decodeUnknownOption(OwnedDynamicConfig);

/**
 * Read every `@file` transport reference the owned route YAML declares for its
 * managed-TLS routes, strictly validating ownership metadata, registration
 * shape, and the content-addressed name against the actual inline body.
 *
 * Observation must not call the certificate authority, mutate files, or trust a
 * cached successful apply. Anything missing, unreadable, malformed, stale, or
 * unexpected yields `undefined`, which callers turn into an `unknown`
 * observation rather than a false `present`.
 */
export const readOwnedBackendTransports = Effect.fnUntraced(function* (
  dependencies: TraefikProxyDependencies,
  owner: AppRouteOwner,
  routes: ReadonlyArray<RoutePlan>,
) {
  if (!routes.some((route) => route.backend.tls !== undefined)) return [];
  const file = routeFile(dependencies.paths, owner);
  if (!(yield* dependencies.fileSystem.exists(file))) return undefined;
  const content = yield* dependencies.fileSystem
    .readText(file)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (content === undefined) return undefined;
  const metadata = parseRouteFileMetadata(content);
  if (metadata === undefined || metadata.app !== owner.id) return undefined;
  const parsed = yield* Effect.try({
    try: () => Bun.YAML.parse(content) as unknown,
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (parsed === undefined) return undefined;
  const config = Option.getOrUndefined(decodeOwnedDynamicConfig(parsed));
  if (config === undefined) return undefined;
  const namespace = routeNamespace(owner);
  // Callers may observe a subset of the owner's routes (one service's, for
  // example), so transports that belong to unrequested routes are expected.
  const entries = Object.entries(config.http.serversTransports ?? {});
  const references: Array<string | undefined> = [];
  for (const route of routes) {
    const tls = route.backend.tls;
    if (tls === undefined) {
      references.push(undefined);
      continue;
    }
    const match = entries
      .filter(([name]) => name.startsWith(`${namespace}tls-`))
      .flatMap(([name, value]) => {
        const body = Option.getOrUndefined(decodeObservedTransportBody(value));
        if (body === undefined) return [];
        if (body.serverName !== tls.serverName) return [];
        const reference = observedTransportReference({
          namespace,
          caId: tls.caId,
          body,
        });
        // The reader reports the bare transport name; callers add `@file` so the
        // reference is spelled once, in the renderer.
        return reference === `${name}@file` ? [{ name, reference: name }] : [];
      });
    const found = match[0];
    if (found === undefined || match.length !== 1) return undefined;
    references.push(found.reference);
  }
  return references;
});
