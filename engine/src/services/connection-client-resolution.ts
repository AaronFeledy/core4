import { ServiceTypeError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeResolution } from "@lando/sdk/services";
import { Effect } from "effect";

export const normalizeConnectionClients = Effect.fnUntraced(function* (
  declaration: Pick<ServiceType, "id" | "toolingForConnection">,
  name: string,
  contribution: {
    readonly raw: ServiceTypeResolution;
    readonly merged?: ServiceTypeResolution;
    readonly parent?: ServiceTypeResolution;
    readonly inheritedFactory?: ServiceType["toolingForConnection"];
  },
) {
  const { raw, parent, inheritedFactory } = contribution;
  if (raw.connection !== undefined && raw.nonSqlCreds !== undefined) {
    return yield* Effect.fail(
      new ServiceTypeError({
        serviceType: declaration.id,
        message:
          "A service type must publish either connection or nonSqlCreds, not both. Publish one canonical credential source.",
        remediation:
          "Correct the service type configuration in the Landofile (see the reported field path), then re-run.",
      }),
    );
  }
  const merged = contribution.merged ?? raw;
  const source = raw.connection !== undefined || raw.nonSqlCreds !== undefined ? raw : (parent ?? raw);
  const { connection: _connection, nonSqlCreds: _nonSqlCreds, ...content } = merged;
  const factory = declaration.toolingForConnection ?? inheritedFactory;
  const generated =
    source.connection === undefined ? {} : (factory?.(ServiceName.make(name), source.connection) ?? {});
  const added =
    raw.connectionClientNames ??
    (declaration.toolingForConnection === undefined
      ? []
      : Object.keys(generated).filter((key) => Object.hasOwn(merged.tooling ?? {}, key)));
  const claims = [
    ...new Set([
      ...(declaration.toolingForConnection === undefined
        ? (parent?.connectionClientNames ?? []).filter((key) => !Object.hasOwn(raw.tooling ?? {}, key))
        : []),
      ...added,
    ]),
  ];
  for (const key of claims) {
    if (
      source.connection === undefined ||
      !Object.hasOwn(merged.tooling ?? {}, key) ||
      !Object.hasOwn(generated, key)
    ) {
      return yield* Effect.fail(
        new ServiceTypeError({
          serviceType: declaration.id,
          message: `Invalid connection-client claim ${key}: publish its task, a canonical connection, and supporting toolingForConnection output, or remove the claim.`,
          remediation:
            "Correct the service type configuration in the Landofile (see the reported field path), then re-run.",
        }),
      );
    }
  }
  return {
    ...content,
    ...(source.connection === undefined ? {} : { connection: source.connection }),
    ...(source.nonSqlCreds === undefined ? {} : { nonSqlCreds: source.nonSqlCreds }),
    connectionClientNames: claims,
  } satisfies ServiceTypeResolution;
});
