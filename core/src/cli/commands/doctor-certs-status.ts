import { Cause, Effect, Exit, Option } from "effect";

import type {
  AmbiguousCertificateAuthoritiesError,
  NoCertificateAuthorityError,
  PluginLoadError,
} from "@lando/sdk/errors";

import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";

export type CertsDoctorStatus =
  | { readonly _tag: "unresolved" }
  | { readonly _tag: "selected"; readonly id: string }
  | { readonly _tag: "unavailable"; readonly detail: string }
  | {
      readonly _tag: "ambiguous";
      readonly candidateIds: ReadonlyArray<string>;
      readonly detail: string;
    }
  | { readonly _tag: "load-failed"; readonly pluginName: string; readonly detail: string };

type ResolutionError = NoCertificateAuthorityError | AmbiguousCertificateAuthoritiesError | PluginLoadError;

export const UNRESOLVED_CERTS_STATUS = {
  _tag: "unresolved",
} as const satisfies CertsDoctorStatus;

const assertNever = (value: never): never => value;

const statusFromFailure = (
  failure: ResolutionError,
  redact: (value: string) => string,
): CertsDoctorStatus => {
  switch (failure._tag) {
    case "NoCertificateAuthorityError":
      return {
        _tag: "unavailable",
        detail: `${redact(failure.message)} ${redact(failure.remediation)}`,
      };
    case "AmbiguousCertificateAuthoritiesError":
      return {
        _tag: "ambiguous",
        candidateIds: failure.candidates.map((candidate) => redact(candidate.id)),
        detail: `${redact(failure.message)} ${redact(failure.remediation)}`,
      };
    case "PluginLoadError":
      return {
        _tag: "load-failed",
        pluginName: redact(failure.pluginName),
        detail: redact(failure.message),
      };
    default:
      return assertNever(failure);
  }
};

export const certsDoctorStatus = (redact: (value: string) => string) =>
  Effect.gen(function* () {
    const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
    if (Option.isNone(resolver)) return UNRESOLVED_CERTS_STATUS;

    const resolved = yield* Effect.exit(resolver.value.resolve);
    if (Exit.isSuccess(resolved)) return { _tag: "selected", id: resolved.value.id } as const;

    const failure = Cause.failureOption(resolved.cause);
    if (Option.isSome(failure)) return statusFromFailure(failure.value, redact);
    return {
      _tag: "load-failed",
      pluginName: "unknown",
      detail: redact(String(Cause.squash(resolved.cause))),
    } as const;
  });

export const certsSubsystemId = (status: CertsDoctorStatus): string => {
  switch (status._tag) {
    case "selected":
      return status.id;
    case "unresolved":
    case "unavailable":
    case "ambiguous":
    case "load-failed":
      return "unavailable";
    default:
      return assertNever(status);
  }
};

export const certsCheckContext = (status: CertsDoctorStatus): Readonly<Record<string, string>> => {
  switch (status._tag) {
    case "unresolved":
    case "selected":
      return {};
    case "unavailable":
      return { certsReason: "unavailable", certsDetail: status.detail };
    case "ambiguous":
      return {
        certsReason: "ambiguous",
        certsCandidateIds: status.candidateIds.join(","),
        certsDetail: status.detail,
      };
    case "load-failed":
      return {
        certsReason: "load-failed",
        certsPlugin: status.pluginName,
        certsDetail: status.detail,
      };
    default:
      return assertNever(status);
  }
};
