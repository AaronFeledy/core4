import { type ServiceConfig, sameImageReference } from "@lando/sdk/schema";
import type { LauncherCommandOptions } from "@lando/sdk/services";

export type ExtraArgsOffending = {
  readonly index: number;
  readonly remediation: string;
};

export type ExtraArgsChecker = LauncherCommandOptions["extraArgs"];

/** Options Lando already pins on a launcher; token-aware, not a general flag parser. */
export type ReservedArgRule =
  | {
      readonly form: "long";
      /** Long option name without leading dashes (`port`, `appendonly`). */
      readonly name: string;
      readonly remediation: string;
      /** When true, a following non-flag token is part of this option. */
      readonly takesValue?: boolean;
    }
  | {
      readonly form: "short";
      /** Single-letter short option without the dash (`p`, `P`, `f`). */
      readonly name: string;
      readonly remediation: string;
      readonly takesValue?: boolean;
    }
  | {
      readonly form: "long-prefix";
      /** Prefix after `--` (`defaults-`). */
      readonly prefix: string;
      readonly remediation: string;
    }
  | {
      /** Postgres-style `-c key=value` (key may be the next token). */
      readonly form: "postgres-c";
      readonly key: string;
      readonly remediation: string;
    };

const isFlagToken = (token: string): boolean => token.startsWith("-");

const longNameOf = (token: string): string | undefined => {
  if (!token.startsWith("--") || token === "--") return undefined;
  const body = token.slice(2);
  const eq = body.indexOf("=");
  return eq === -1 ? body : body.slice(0, eq);
};

const shortBodyOf = (token: string): string | undefined => {
  if (!token.startsWith("-") || token.startsWith("--") || token === "-") return undefined;
  return token.slice(1);
};

/**
 * Return the first reserved extraArgs token, if any.
 * Pure and token-aware: understands `--name`, `--name=value`, `-x`, `-xvalue`,
 * and postgres `-c key=value` / `-c` + `key=value`.
 */
export const firstReservedExtraArg = (
  args: readonly string[],
  rules: readonly ReservedArgRule[],
): ExtraArgsOffending | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    const next = args[index + 1];

    for (const rule of rules) {
      if (rule.form === "long") {
        const name = longNameOf(token);
        if (name !== rule.name) continue;
        return { index, remediation: rule.remediation };
      }
      if (rule.form === "long-prefix") {
        const name = longNameOf(token);
        if (name === undefined || !name.startsWith(rule.prefix)) continue;
        return { index, remediation: rule.remediation };
      }
      if (rule.form === "short") {
        const body = shortBodyOf(token);
        if (body === undefined) continue;
        if (body === rule.name || (rule.takesValue && body.startsWith(rule.name))) {
          return { index, remediation: rule.remediation };
        }
        continue;
      }
      if (rule.form === "postgres-c") {
        if (token === "-c") {
          const assignment = next;
          if (assignment !== undefined && assignmentStartsWithKey(assignment, rule.key)) {
            return { index, remediation: rule.remediation };
          }
          continue;
        }
        if (token.startsWith("-c") && token.length > 2 && assignmentStartsWithKey(token.slice(2), rule.key)) {
          return { index, remediation: rule.remediation };
        }
      }
    }

    // Skip the value token of a recognized non-reserved option so `-m 64` does not
    // treat `64` as a short flag. Reserved hits already returned above.
    if (isFlagToken(token) && next !== undefined && !isFlagToken(next)) {
      const long = longNameOf(token);
      if (long !== undefined && !token.includes("=")) {
        index += 1;
        continue;
      }
      const short = shortBodyOf(token);
      if (short !== undefined && short.length === 1) {
        index += 1;
      }
    }
  }
  return undefined;
};

const assignmentStartsWithKey = (assignment: string, key: string): boolean => {
  if (assignment === key) return true;
  return assignment.startsWith(`${key}=`) || assignment.startsWith(`${key} `);
};

export const reservedExtraArgs = (rules: readonly ReservedArgRule[]): ExtraArgsChecker => {
  return (args) => firstReservedExtraArg(args, rules);
};

export const PORT_EXTRA_ARGS_REMEDIATION = "Set port: instead of overriding the listen port in extraArgs.";

export const extraArgsCommandOptions = (rules: readonly ReservedArgRule[]): LauncherCommandOptions => ({
  extraArgs: reservedExtraArgs(rules),
});

/** True when the author replaced the catalog image or used a contextual Compose build. */
export const isNonCatalogArtifact = (
  service: Pick<ServiceConfig, "image" | "build">,
  catalogImages: readonly string[],
): boolean => {
  if (service.build !== undefined && "context" in service.build) return true;
  const image = service.image?.trim();
  if (image === undefined || image.length === 0) return false;
  return !catalogImages.some((catalog) => sameImageReference(image, catalog));
};

export const CUSTOM_DB_EXTRA_ARGS_REMEDIATION =
  "extraArgs requires the catalog image so Lando can forward CMD to the daemon. Remove image: or build.context, or put the flags in command:.";

export const catalogDbExtraArgsRemediation =
  (catalogImages: readonly string[], idleRemediation: string) =>
  (config: ServiceConfig): string =>
    isNonCatalogArtifact(config, catalogImages) ? CUSTOM_DB_EXTRA_ARGS_REMEDIATION : idleRemediation;

export const LANGUAGE_EXTRA_ARGS_REMEDIATION =
  "Language runtimes keep a keep-alive process by default. Put server flags in command:, or remove extraArgs.";

export const RAW_BASE_EXTRA_ARGS_REMEDIATION =
  "This service type has no Lando-owned launcher. Put flags in command:, or remove extraArgs.";

export const IMAGE_DEFAULT_EXTRA_ARGS_REMEDIATION = (mechanism: string): string =>
  `This service starts from the image default and is configured through ${mechanism}. Put flags in command:, or remove extraArgs.`;

export const UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION = (type: string, alternative: string): string =>
  `${type} does not accept extraArgs. ${alternative}`;
