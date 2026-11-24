/**
 * `meta:setup` certificate-authority step: resolves the authority, runs its
 * `setup`, and reports each host trust store it manages. A trust-installing run
 * turns every store left without the local CA into a `CA_TRUST_INCOMPLETE`
 * warning; readiness stays satisfied because the authority still issues
 * certificates.
 */

import {
  commandWarningsUseMachineOutput,
  recordCommandWarning,
} from "@lando/engine/landofile/command-warnings";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { CommandWarning, TrustStoreChange } from "@lando/sdk/schema";
import { CertificateAuthority, EventService, type PrivilegeService } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";
import { inputBooleanFlag } from "./setup-inputs";
import { recordAbsentHostIntegration } from "./setup-service-steps";
import type { SetupReadinessRecorder } from "./setup-steps";

type SetupPrivilegeOptions = {
  readonly privilege?: Context.Service.Shape<typeof PrivilegeService>;
};

const SKIP_CA_TRUST_EVIDENCE = "Certificate authority trust installation skipped by --skip-install-ca.";

const sentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

/** One warning per store a trust-installing run left without the local CA. */
const trustIncompleteWarning = (store: TrustStoreChange): CommandWarning => {
  const where = store.location === undefined ? "" : ` at ${store.location}`;
  const why = store.detail === undefined ? "" : `: ${store.detail}`;
  return {
    code: "CA_TRUST_INCOMPLETE",
    message: sentence(`${store.name}${where} does not trust the local CA${why}`),
    ...(store.remediation === undefined ? {} : { remediation: store.remediation }),
    context: { store: store.id, ...(store.location === undefined ? {} : { location: store.location }) },
  };
};

const trustSummary = (stores: ReadonlyArray<TrustStoreChange>): string =>
  stores
    .map(
      ({ name, location, state, changed }) =>
        `${name}${location === undefined ? "" : ` (${location})`}: ${state}${changed ? ", updated" : ""}.`,
    )
    .join(" ");

export const runCaSetupStep = Effect.fn("SetupCommand.runCaSetupStep")(function* (
  input: unknown,
  privilegeOptions: SetupPrivilegeOptions,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
  platform: NodeJS.Platform = process.platform,
) {
  const skipTrustInstall = inputBooleanFlag(input, "skip-install-ca");
  const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
  const authority = yield* Effect.serviceOption(CertificateAuthority);
  if (resolver._tag === "None" && authority._tag === "None") {
    if (skipTrustInstall) {
      yield* recorder.record({ id: "ca", status: "skipped", evidence: SKIP_CA_TRUST_EVIDENCE });
    } else {
      yield* recordAbsentHostIntegration(recorder, selectedProviderId, "ca", "Certificate authority");
    }
    return undefined;
  }
  const ca =
    resolver._tag === "Some"
      ? yield* resolver.value.resolve.pipe(
          Effect.catchTag("NoCertificateAuthorityError", (cause) =>
            Effect.as(
              skipTrustInstall
                ? recorder.record({ id: "ca", status: "skipped", evidence: SKIP_CA_TRUST_EVIDENCE })
                : recorder.record({
                    id: "ca",
                    status: "unavailable",
                    evidence: cause.message,
                    remediation: cause.remediation,
                  }),
              undefined,
            ),
          ),
          Effect.catchTag("AmbiguousCertificateAuthoritiesError", (cause) =>
            Effect.as(
              recorder.record({
                id: "ca",
                status: "failed",
                evidence: cause.message,
                remediation: cause.remediation,
              }),
              undefined,
            ),
          ),
          Effect.tapError((cause) => recorder.recordFailure("ca", cause)),
        )
      : authority._tag === "Some"
        ? authority.value
        : undefined;
  if (ca === undefined) return undefined;
  const events = yield* Effect.serviceOption(EventService);
  // Narration is best-effort: a renderer failure must not fail the step it describes.
  const narrate = (event: MessageInfoEvent | MessageWarnEvent) =>
    events._tag === "Some" ? events.value.publish(event).pipe(Effect.ignore) : Effect.void;
  if (platform === "win32" && !skipTrustInstall) {
    yield* narrate(
      MessageInfoEvent.make({
        body: "Installing local certificate trust.\nWindows may open a Security Warning. Approve it to continue.\n--yes cannot answer Windows security prompts.",
        timestamp: yield* DateTime.now,
      }),
    );
  }
  const { trustStores } = yield* ca
    .setup({
      force: false,
      ...privilegeOptions,
      ...(skipTrustInstall ? { skipTrustInstall: true } : {}),
    })
    .pipe(Effect.tapError((cause) => recorder.recordFailure("ca", cause)));
  for (const { name, location } of trustStores.filter(({ changed }) => changed)) {
    const body = `Trusted the local CA in ${name}${location === undefined ? "" : ` (${location})`}.`;
    yield* narrate(MessageInfoEvent.make({ body, timestamp: yield* DateTime.now }));
  }
  // Skipping trust installation leaves stores untrusted on purpose; only an installing run warns.
  const warnings = skipTrustInstall
    ? []
    : trustStores.filter(({ state }) => state !== "trusted").map(trustIncompleteWarning);
  // Machine output carries warnings in the result envelope; people read them as they happen.
  for (const warning of warnings) yield* recordCommandWarning(warning);
  if (!(yield* commandWarningsUseMachineOutput)) {
    for (const { message, remediation } of warnings) {
      const body = remediation === undefined ? message : `${message} ${remediation}`;
      yield* narrate(MessageWarnEvent.make({ body, timestamp: yield* DateTime.now }));
    }
  }
  const firstWarning = warnings[0];
  yield* recorder.record({
    id: "ca",
    status: skipTrustInstall ? "skipped" : "satisfied",
    evidence: [
      skipTrustInstall ? SKIP_CA_TRUST_EVIDENCE : "Certificate authority setup completed.",
      ...(trustStores.length === 0 ? [] : [trustSummary(trustStores)]),
    ].join(" "),
    ...(firstWarning?.remediation === undefined ? {} : { remediation: firstWarning.remediation }),
  });
  return trustStores;
});
