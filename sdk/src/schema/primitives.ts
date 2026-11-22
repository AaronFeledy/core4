import { Schema } from "effect";

export const AppId = Schema.String.pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

export const ServiceName = Schema.String.pipe(Schema.brand("ServiceName"));
export type ServiceName = typeof ServiceName.Type;

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));
export type ProviderId = typeof ProviderId.Type;

export const PluginName = Schema.String.pipe(Schema.brand("PluginName"));
export type PluginName = typeof PluginName.Type;

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

export const PortablePath = Schema.String.pipe(Schema.brand("PortablePath"));
export type PortablePath = typeof PortablePath.Type;

/** Integer TCP/UDP port in the inclusive IANA range. */
export const PortNumber = Schema.Number.annotate({
  description: "TCP or UDP port number from 1 through 65535.",
}).pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })));
export type PortNumber = typeof PortNumber.Type;

/**
 * A container identity: a name or numeric id, optionally followed by a group
 * name or gid. The allowlist keeps the value safe to interpolate into a
 * `USER` instruction and into a provider exec request.
 */
export const CONTAINER_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/u;

export const isContainerUser = (value: string): boolean => CONTAINER_USER_PATTERN.test(value);

/**
 * Whether a container identity names the root principal. `root`, `0`, and any
 * numeric spelling of uid 0 count; a group suffix does not change the user.
 * An omitted identity is not root: callers decide their own default.
 */
export const isRootContainerUser = (value: string): boolean => {
  const user = value.split(":", 1)[0] ?? "";
  return user === "root" || (/^[0-9]+$/u.test(user) && Number(user) === 0);
};

const containerUserDescription =
  'Container identity as "<name|uid>" or "<name|uid>:<group|gid>". Letters, digits, underscores, dots, and hyphens only, and each part must start with a letter, digit, or underscore.';

export const ContainerUser = Schema.String.annotate({ description: containerUserDescription })
  .pipe(
    Schema.check(
      Schema.isPattern(CONTAINER_USER_PATTERN, {
        message: "Expected a container user name or numeric id, optionally followed by :group or :gid",
      }),
    ),
  )
  .annotate({ description: containerUserDescription });
export type ContainerUser = typeof ContainerUser.Type;

/**
 * The in-container identity whose files belong to the host user on a provider
 * that maps one container id to the host user. The name is the identity a
 * service type declares (for PHP, `www-data`); numeric ids are what an exec
 * request and a `chown` use, because a custom image may not carry the name.
 */
export const ServiceProjectUser = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "Principal name the service type declares, or the numeric uid when only ids are known.",
  }),
  uid: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })),
  ).annotate({ description: "Numeric user id inside the container." }),
  gid: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })),
  ).annotate({ description: "Numeric primary group id inside the container." }),
}).annotate({
  identifier: "ServiceProjectUser",
  description: "Container identity that owns files a service creates on the host.",
});
export type ServiceProjectUser = typeof ServiceProjectUser.Type;

/**
 * Why a service has no realized project user. Kept beside the plan so info and
 * lint can explain an absence instead of leaving it implicit.
 */
export const ProjectUserExplanation = Schema.Struct({
  state: Schema.Literals(["opted-out", "provider-unsupported", "unresolved", "not-applicable"]).annotate({
    description:
      "opted-out means projectUser: false; provider-unsupported means the provider cannot map an id; unresolved means no identity could be chosen; not-applicable means the service is not a user app with an app-source bind.",
  }),
  explicit: Schema.Boolean.annotate({
    description: "Whether the Landofile authored projectUser instead of relying on resolution.",
  }),
  detail: Schema.String.annotate({ description: "Human-readable reason for the resolved plan." }),
}).annotate({
  identifier: "ProjectUserExplanation",
  description: "Structured explanation for a service plan with no realized project user.",
});
export type ProjectUserExplanation = typeof ProjectUserExplanation.Type;

/**
 * An absolute path inside a container. The leading slash is required so a
 * destination is never resolved against an unknown working directory, and NUL
 * and backslash are rejected so the value stays safe to carry into a mount
 * destination and a provider request.
 */
export const ABSOLUTE_CONTAINER_PATH_PATTERN = /^\/[^\0\\]*$/u;

export const isAbsoluteContainerPath = (value: string): boolean =>
  ABSOLUTE_CONTAINER_PATH_PATTERN.test(value);

export const AbsoluteContainerPath = Schema.String.annotate({
  description:
    "Absolute path inside a container. Must start with '/' and must not contain NUL or backslash characters.",
}).pipe(
  Schema.check(
    Schema.isPattern(ABSOLUTE_CONTAINER_PATH_PATTERN, {
      message: "Expected an absolute container path",
    }),
  ),
);
export type AbsoluteContainerPath = typeof AbsoluteContainerPath.Type;

export const HostPlatform = Schema.Literals(["darwin", "linux", "win32", "wsl"]);
export type HostPlatform = typeof HostPlatform.Type;

export const HostPlatformFamily = Schema.Literals(["darwin", "linux", "win32"]);
export type HostPlatformFamily = typeof HostPlatformFamily.Type;

const HOST_PLATFORM_FAMILY = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
  wsl: "linux",
} as const satisfies Record<HostPlatform, HostPlatformFamily>;

export const hostPlatformFamily = (platform: HostPlatform): HostPlatformFamily =>
  HOST_PLATFORM_FAMILY[platform];

export const HostArchitecture = Schema.Literals(["x64", "arm64"]);
export type HostArchitecture = typeof HostArchitecture.Type;

export const BootstrapLevel = Schema.Literals([
  "none",
  "minimal",
  "plugins",
  "commands",
  "tooling",
  "provider",
  "global",
  "scratch",
  "app",
]);
export type BootstrapLevel = typeof BootstrapLevel.Type;

export const BOOTSTRAP_RANK: Record<BootstrapLevel, number> = {
  none: 0,
  minimal: 1,
  plugins: 2,
  commands: 3,
  tooling: 4,
  provider: 5,
  global: 6,
  scratch: 7,
  app: 8,
};

/**
 * Plan metadata — every plan node carries this for traceability.
 */
export const PlanMetadata = Schema.Struct({
  /** Resolution timestamp (UTC). */
  resolvedAt: Schema.DateTimeUtcFromString,
  /** Source Landofile path (or virtual id for recipe-rendered apps). */
  source: Schema.String,
  /** Lando runtime/format major version this plan was rendered for. */
  runtime: Schema.Literal(4),
});
export type PlanMetadata = typeof PlanMetadata.Type;

/**
 * Provider extension config — non-portable, opt-in provider-specific config
 * preserved in the schema. Keys are provider ids; values are arbitrary.
 */
export const ProviderExtensionConfig = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderExtensionConfig = typeof ProviderExtensionConfig.Type;

/**
 * `command` / `entrypoint` accept either a single string or an argv array.
 */
export const CommandSpec = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
export type CommandSpec = typeof CommandSpec.Type;

/**
 * ToolingVarLiteral — a scalar literal value for a Landofile `tooling.<task>.vars.<name>`.
 */
export const ToolingVarLiteral = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type ToolingVarLiteral = typeof ToolingVarLiteral.Type;
