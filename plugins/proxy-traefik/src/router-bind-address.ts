/**
 * Effective `router.bindAddress` for Traefik publication and doctor.
 *
 * Precedence: ConfigService (already includes env overlays) when present,
 * then `LANDO_ROUTER_BIND_ADDRESS` / env overlay, then loopback.
 */
import { envOverlay } from "@lando/paths/overlay";
import { ConfigService } from "@lando/sdk/services";
import { Effect } from "effect";

export const DEFAULT_ROUTER_BIND_ADDRESS = "127.0.0.1";

export const UNSPECIFIED_BIND_REMEDIATION =
  "your proxy is reachable from your local network; unset router.bindAddress or set 127.0.0.1";

export type RouterBindKind = "loopback" | "unspecified" | "specific";

const stripBrackets = (value: string): string =>
  value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

const bindFromUnknown = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const bind = "bindAddress" in value ? value.bindAddress : undefined;
  return typeof bind === "string" && bind.trim().length > 0 ? bind : undefined;
};

export const routerBindAddressFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => bindFromUnknown(envOverlay({ ...env }).router);

export const resolveRouterBindAddress = (input: {
  readonly configured?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string => {
  const configured = input.configured?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return routerBindAddressFromEnv(input.env ?? {}) ?? DEFAULT_ROUTER_BIND_ADDRESS;
};

export const resolveEffectiveRouterBindAddress = Effect.fnUntraced(function* (
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configOpt = yield* Effect.serviceOption(ConfigService);
  const configured =
    configOpt._tag === "Some"
      ? yield* configOpt.value.load.pipe(Effect.map((config) => config.router?.bindAddress))
      : undefined;
  return resolveRouterBindAddress({ configured, env });
});

export const classifyRouterBindAddress = (value: string): RouterBindKind => {
  const address = stripBrackets(value.trim()).toLowerCase();
  if (address === "0.0.0.0" || address === "::") return "unspecified";
  if (address === "127.0.0.1" || address === "::1" || address === "localhost") return "loopback";
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/u.test(address)) return "loopback";
  return "specific";
};
