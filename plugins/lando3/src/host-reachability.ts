/**
 * Host reachability for converted services. Lando 4 adds `host.lando.internal`
 * and `LANDO_HOST_IP` itself when the provider can reach the host, so the hand
 * wiring Lando 3 apps carry is removed instead of copied: copying it would
 * duplicate the alias, or fabricate one on a provider that cannot reach the host.
 */
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import { type ServiceLoweringContext, isPlainObject } from "./lowering-contract.ts";
import { rewrittenServiceKey } from "./service-diagnostics.ts";

export const HOST_ALIAS = "host.lando.internal";
export const HOST_IP_VARIABLE = "LANDO_HOST_IP";

const isHostAliasName = (name: string): boolean => name.toLowerCase() === HOST_ALIAS;

const isHostAliasEntry = (entry: unknown): boolean => {
  const name = typeof entry === "string" ? entry.trim().split(/[:=\s]/u)[0] : undefined;
  return name !== undefined && isHostAliasName(name);
};

/**
 * Removes hand-wired host reachability from Compose `extra_hosts`. Lando 4
 * adds the alias itself whenever the provider can reach the host, so copying
 * the entry would duplicate it, and on a provider that cannot, fabricate it.
 */
export const withoutHostAlias = (
  value: unknown,
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
  diagnostics: ConfigTranslateDiagnostic[],
): unknown => {
  const rewrite = (path: Lando3Path): void => {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative: path,
        message: `Removed ${HOST_ALIAS}: Lando 4 adds it, with ${HOST_IP_VARIABLE}, whenever the provider can reach the host.`,
        remediation: `Use ${HOST_ALIAS} or $${HOST_IP_VARIABLE} inside the container; check for ${HOST_IP_VARIABLE} on providers that cannot reach the host.`,
      }),
    );
  };
  if (Array.isArray(value)) {
    const kept = value.filter((entry: unknown, index) => {
      if (!isHostAliasEntry(entry)) return true;
      rewrite([...relative, index]);
      return false;
    });
    return kept.length === 0 ? undefined : kept;
  }
  if (isPlainObject(value)) {
    const aliasKey = Object.keys(value).find((key) => isHostAliasName(key));
    if (aliasKey !== undefined) {
      rewrite([...relative, aliasKey]);
      const { [aliasKey]: _alias, ...kept } = value;
      return Object.keys(kept).length === 0 ? undefined : kept;
    }
  }
  return value;
};

/** Drops an authored `LANDO_HOST_IP`; Lando 4 owns it and derives it from capability. */
export const withoutHostIpVariable = (
  environment: Readonly<Record<string, string>>,
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
  diagnostics: ConfigTranslateDiagnostic[],
): Readonly<Record<string, string>> => {
  if (!Object.hasOwn(environment, HOST_IP_VARIABLE)) return environment;
  diagnostics.push(
    rewrittenServiceKey({
      ctx,
      relative: [...relative, HOST_IP_VARIABLE],
      message: `Removed ${HOST_IP_VARIABLE}: Lando 4 sets it to ${HOST_ALIAS} whenever the provider can reach the host.`,
      remediation: `Read $${HOST_IP_VARIABLE} inside the container instead of setting it; it is absent when the host is unreachable.`,
    }),
  );
  const { [HOST_IP_VARIABLE]: _ip, ...kept } = environment;
  return kept;
};
