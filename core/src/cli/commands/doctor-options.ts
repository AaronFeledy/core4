import type { HostPlatform } from "@lando/sdk/schema";

export interface DoctorOptions {
  readonly flagProviderId?: string | undefined;
  readonly landofileProviderId?: string | undefined;
  /** Environment lookup used for `LANDO_PROVIDER`. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Host platform used when resolving the Podman socket for provider checks. */
  readonly platform?: HostPlatform | undefined;
  /** Re-run setup for degraded subsystems whose recovery is safe to automate. */
  readonly fix?: boolean | undefined;
  /** Additionally lint the current app's Landofile against the canonical schema. */
  readonly app?: boolean | undefined;
  readonly deprecations?: boolean | undefined;
  readonly diedEventPayloads?: ReadonlyArray<unknown> | undefined;
  readonly format?: "text" | "json" | "yaml" | undefined;
  /** Cancels the run when aborted instead of letting the CLI SIGINT handler absorb it. */
  readonly signal?: AbortSignal | undefined;
}
