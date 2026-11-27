import { CORE_VERSION } from "@lando/engine/version";
import {
  AppliedStateVersionError,
  NoProviderInstalledError,
  ProviderUnavailableError,
  newerStateRemediation,
} from "@lando/sdk/errors";
import type { UnreadableAppliedState } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding } from "./doctor-contract";

const MAX_PROTECTED_FINDINGS = 50;

const inventoryUnavailable = (input: {
  readonly redact: (text: string) => string;
  readonly providerId?: string;
  readonly message: string;
  readonly remediation: string;
}): DoctorFinding =>
  warnCheck({
    name: "applied-state-inventory",
    recovery: "manual",
    ...(input.providerId === undefined ? {} : { subject: input.redact(input.providerId) }),
    context: {
      ...(input.providerId === undefined ? {} : { providerId: input.redact(input.providerId) }),
      error: input.redact(input.message),
    },
    solutions: [{ kind: "manual", description: input.redact(input.remediation) }],
  });

const protectedRecord = (input: {
  readonly redact: (text: string) => string;
  readonly providerId: string;
  readonly issue: typeof UnreadableAppliedState.Encoded;
}): DoctorFinding => {
  const { redact, providerId, issue } = input;
  const context: DoctorFinding["context"] = {
    providerId: redact(providerId),
    path: redact(issue.path),
    reason: issue.reason,
    ...(issue.appId === undefined ? {} : { appId: redact(issue.appId) }),
  };
  if (issue.reason === "newer-version") {
    const writtenBy = issue.writtenBy;
    const remediation = newerStateRemediation({
      ...issue,
      reader: CORE_VERSION,
    });
    return warnCheck({
      name: "applied-state",
      subject: redact(issue.path),
      recovery: "manual",
      context: {
        ...context,
        storedVersion: String(issue.storedVersion),
        supportedVersion: String(issue.supportedVersion),
        ...(writtenBy === undefined ? {} : { writtenBy: redact(writtenBy) }),
      },
      solutions: [{ kind: "manual", description: redact(remediation) }],
    });
  }
  return warnCheck({
    name: "applied-state",
    subject: redact(issue.path),
    recovery: "manual",
    context,
    solutions: [
      {
        kind: "manual",
        description: redact(
          `Applied-state record "${issue.path}" could not be read. Restore a readable copy from a trusted backup or, accepting that unflushed accelerated sync changes may be lost, move it aside and rerun lando doctor.`,
        ),
      },
    ],
  });
};

const fromInventoryFailure = (input: {
  readonly redact: (text: string) => string;
  readonly providerId: string;
  readonly failure: unknown;
}): DoctorFinding => {
  const { redact, providerId, failure } = input;
  if (failure instanceof AppliedStateVersionError) {
    const { path, storedVersion, supportedVersion, appId, writtenBy } = failure;
    return protectedRecord({
      redact,
      providerId,
      issue: {
        reason: "newer-version",
        path,
        storedVersion,
        supportedVersion,
        ...(appId === undefined ? {} : { appId }),
        ...(writtenBy === undefined ? {} : { writtenBy }),
      },
    });
  }
  if (failure instanceof ProviderUnavailableError || failure instanceof NoProviderInstalledError) {
    return inventoryUnavailable({
      redact,
      providerId,
      message: failure.message,
      remediation: failure.remediation,
    });
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  return inventoryUnavailable({
    redact,
    providerId,
    message,
    remediation:
      "Lando could not finish reading applied state for this provider. Fix the reported problem, then rerun lando doctor.",
  });
};

/** Reads the filesystem inventory without selecting or building a provider runtime. */
export const stateCompatibilityDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry))
    return [
      inventoryUnavailable({
        redact,
        message: "The applied-state inventory is unavailable.",
        remediation: "Review the other doctor findings and rerun lando doctor.",
      }),
    ];

  const listed = yield* registry.value.list.pipe(Effect.result);
  if (Result.isFailure(listed)) {
    return [
      inventoryUnavailable({
        redact,
        message: listed.failure.message,
        remediation: listed.failure.remediation,
      }),
    ];
  }

  const checks: DoctorFinding[] = [];
  let truncated = false;
  for (const providerId of listed.success) {
    if (checks.length >= MAX_PROTECTED_FINDINGS) {
      truncated = true;
      break;
    }
    const inventory = yield* registry.value.appliedStateInventory(providerId).pipe(Effect.result);
    if (Result.isFailure(inventory)) {
      checks.push(fromInventoryFailure({ redact, providerId, failure: inventory.failure }));
      continue;
    }
    for (const issue of inventory.success.unreadable) {
      if (checks.length >= MAX_PROTECTED_FINDINGS) {
        truncated = true;
        break;
      }
      checks.push(protectedRecord({ redact, providerId, issue }));
    }
  }

  if (truncated) {
    checks.push(
      warnCheck({
        name: "state-compatibility",
        recovery: "manual",
        context: { truncated: "true", limit: String(MAX_PROTECTED_FINDINGS) },
        solutions: [
          {
            kind: "manual",
            description: redact(
              `Doctor stopped after ${MAX_PROTECTED_FINDINGS} protected applied-state findings. Resolve those first, then rerun lando doctor --section state-compatibility.`,
            ),
          },
        ],
      }),
    );
  }

  if (checks.length === 0) {
    return [passCheckNamed({ name: "state-compatibility", recovery: "manual", context: {} })];
  }
  return checks;
});
