import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";

import type {
  AmbiguousCertificateAuthoritiesError,
  CaError,
  NoCertificateAuthorityError,
  PluginLoadError,
} from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";

import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding } from "./doctor-contract";
import { CERTS_SPEC, buildDegradedCheck } from "./doctor-subsystem-checks";

export type CertsDoctorStatus =
  | { readonly _tag: "unresolved" }
  | { readonly _tag: "selected"; readonly id: string; readonly trusted: boolean }
  | {
      readonly _tag: "root-unavailable";
      readonly id: string;
      readonly detail: string;
      readonly remediation: string;
    }
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

export const certsDoctorStatus = Effect.fnUntraced(function* (redact: (value: string) => string) {
  const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
  if (Option.isNone(resolver)) return UNRESOLVED_CERTS_STATUS;

  const resolved = yield* Effect.exit(resolver.value.resolve);
  if (Exit.isSuccess(resolved)) return yield* statusFromRoot(resolved.value, redact);

  const failure = Cause.findErrorOption(resolved.cause);
  if (Option.isSome(failure)) return statusFromFailure(failure.value, redact);
  return {
    _tag: "load-failed",
    pluginName: "unknown",
    detail: redact(String(Cause.squash(resolved.cause))),
  } as const;
});

const isCaError = (error: unknown): error is CaError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "CaError";

/** Read `root` only. Selection without a readable root is not "selected". */
const statusFromRoot = Effect.fnUntraced(function* (
  authority: {
    readonly id: string;
    readonly root: Effect.Effect<{ readonly certificate: string; readonly trusted: boolean }, CaError>;
  },
  redact: (value: string) => string,
) {
  const rooted = yield* Effect.exit(authority.root);
  if (Exit.isSuccess(rooted))
    return { _tag: "selected", id: authority.id, trusted: rooted.value.trusted } as const;
  if (Cause.hasInterrupts(rooted.cause)) return yield* Effect.interrupt;
  const failure = Cause.findErrorOption(rooted.cause);
  if (Option.isSome(failure) && isCaError(failure.value)) {
    return {
      _tag: "root-unavailable",
      id: authority.id,
      detail: redact(failure.value.message),
      remediation: redact(failure.value.remediation),
    } as const;
  }
  return {
    _tag: "load-failed",
    pluginName: authority.id,
    detail: redact(String(Cause.squash(rooted.cause))),
  } as const;
});

const UNTRUSTED_CA =
  "Browsers will warn on HTTPS URLs until this machine trusts the local CA. Run `lando setup` without `--skip-install-ca`.";

export const certsSubsystemCheck = Effect.fnUntraced(function* (
  status: CertsDoctorStatus,
  fix: boolean,
): Effect.fn.Return<DoctorFinding | undefined, never> {
  if (status._tag === "selected" && status.trusted) {
    return passCheckNamed({
      name: "certs",
      recovery: "manual",
      context: {
        subsystem: "certs",
        subsystemId: status.id,
        ready: "true",
        certsTrusted: "true",
      },
    });
  }
  if (status._tag === "selected") {
    return warnCheck({
      name: "certs",
      recovery: "manual",
      context: {
        subsystem: "certs",
        subsystemId: status.id,
        ready: "false",
        certsTrusted: "false",
        certsReason: "untrusted",
        ...(fix ? { fixOutcome: "skipped-manual" } : {}),
      },
      solutions: [{ kind: "manual", description: UNTRUSTED_CA, command: "lando setup" }],
    });
  }
  if (status._tag === "root-unavailable") {
    return warnCheck({
      name: "certs",
      recovery: "manual",
      context: {
        subsystem: "certs",
        subsystemId: status.id,
        ready: "false",
        ...certsCheckContext(status),
        ...(fix ? { fixOutcome: "skipped-manual" } : {}),
      },
      solutions: [{ kind: "manual", description: status.remediation, command: "lando setup" }],
    });
  }
  return yield* buildDegradedCheck(
    CERTS_SPEC,
    {
      subsystem: "certs",
      subsystemId: certsSubsystemId(status),
      ready: "false",
      ...certsCheckContext(status),
    },
    fix,
  );
});

export const certsSubsystemId = (status: CertsDoctorStatus): string => {
  switch (status._tag) {
    case "selected":
    case "root-unavailable":
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
    case "root-unavailable":
      return { certsReason: "root-unavailable", certsDetail: status.detail };
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
