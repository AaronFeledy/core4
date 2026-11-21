import { type ServiceConfig, sameImageReference } from "@lando/sdk/schema";
import type { LauncherCommandOptions } from "@lando/sdk/services";
import { absurd } from "effect";

export type ExtraArgsOffending = {
  readonly index: number;
  readonly remediation: string;
};

/** Options Lando already pins on a launcher; token-aware, not a general flag parser. */
export type ReservedArgRule =
  | {
      readonly form: "long";
      /** Long option name without leading dashes (`port`, `appendonly`). */
      readonly name: string;
      readonly remediation: string;
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
 * Report the option's argv index, including the index of `-c` in `-c key=value`.
 */
export const firstReservedExtraArg = (
  args: readonly string[],
  rules: readonly ReservedArgRule[],
): ExtraArgsOffending | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    const long = longNameOf(token);
    const short = shortBodyOf(token);

    for (const rule of rules) {
      switch (rule.form) {
        case "long":
          if (long === rule.name) return { index, remediation: rule.remediation };
          break;
        case "long-prefix":
          if (long?.startsWith(rule.prefix)) return { index, remediation: rule.remediation };
          break;
        case "short":
          if (short === rule.name || (rule.takesValue && short?.startsWith(rule.name))) {
            return { index, remediation: rule.remediation };
          }
          break;
        case "postgres-c": {
          if (!token.startsWith("-c")) break;
          const assignment = token === "-c" ? args[index + 1] : token.slice(2);
          if (assignment !== undefined && assignmentStartsWithKey(assignment, rule.key)) {
            return { index, remediation: rule.remediation };
          }
          break;
        }
        default:
          return absurd(rule);
      }
    }
  }
  return undefined;
};

const assignmentStartsWithKey = (assignment: string, key: string): boolean => {
  if (assignment === key) return true;
  return assignment.startsWith(`${key}=`) || assignment.startsWith(`${key} `);
};

export const PORT_EXTRA_ARGS_REMEDIATION = "Set port: instead of overriding the listen port in extraArgs.";

export const RESERVED_LONG_PORT = {
  form: "long",
  name: "port",
  remediation: PORT_EXTRA_ARGS_REMEDIATION,
} as const satisfies ReservedArgRule;

export const extraArgsCommandOptions = (rules: readonly ReservedArgRule[]): LauncherCommandOptions => ({
  extraArgs: (args) => firstReservedExtraArg(args, rules),
});

export const MYSQL_FAMILY_EXTRA_ARGS = extraArgsCommandOptions([
  RESERVED_LONG_PORT,
  { form: "short", name: "P", remediation: PORT_EXTRA_ARGS_REMEDIATION, takesValue: true },
  {
    form: "long-prefix",
    prefix: "defaults-",
    remediation: "Set config.server instead of --defaults-* in extraArgs.",
  },
]);

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

export const configFileDbExtraArgsRemediation = (catalogImages: readonly string[], daemon: string) =>
  catalogDbExtraArgsRemediation(
    catalogImages,
    `Put ${daemon} flags in command:, set config.server for a config file, or remove extraArgs.`,
  );

export const LANGUAGE_EXTRA_ARGS_REMEDIATION =
  "Language runtimes keep a keep-alive process by default. Put server flags in command:, or remove extraArgs.";

export const RAW_BASE_EXTRA_ARGS_REMEDIATION =
  "This service type has no Lando-owned launcher. Put flags in command:, or remove extraArgs.";

export const IMAGE_DEFAULT_EXTRA_ARGS_REMEDIATION = (mechanism: string): string =>
  `This service starts from the image default and is configured through ${mechanism}. Put flags in command:, or remove extraArgs.`;

export const UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION = (type: string, alternative: string): string =>
  `${type} does not accept extraArgs. ${alternative}`;
