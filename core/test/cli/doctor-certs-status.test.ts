import { describe, expect, test } from "bun:test";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";

import {
  AmbiguousCertificateAuthoritiesError,
  CaError,
  NoCertificateAuthorityError,
  PluginLoadError,
} from "@lando/sdk/errors";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  type CertsDoctorStatus,
  UNRESOLVED_CERTS_STATUS,
  certsCheckContext,
  certsDoctorStatus,
  certsSubsystemId,
} from "../../src/cli/commands/doctor-certs-status.ts";

const redact = (value: string): string => value.replaceAll("secret", "[redacted]");

const resolveStatus = (
  resolve: typeof CertificateAuthorityResolver.Service.resolve,
): Promise<CertsDoctorStatus> =>
  Effect.runPromise(
    certsDoctorStatus(redact).pipe(
      Effect.provideService(CertificateAuthorityResolver, CertificateAuthorityResolver.of({ resolve })),
    ),
  );

describe("certificate authority doctor status", () => {
  test("returns unresolved when the resolver service is absent", async () => {
    // Given / When
    const status = await Effect.runPromise(certsDoctorStatus(redact));

    // Then
    expect(status).toEqual(UNRESOLVED_CERTS_STATUS);
  });

  test("returns selected when the resolver selects an authority", async () => {
    // Given
    const authority = { ...makeTestCertificateAuthority(), id: "mkcert" };

    // When
    const status = await resolveStatus(Effect.succeed(authority));

    // Then
    expect(status).toEqual({ _tag: "selected", id: "mkcert", trusted: true });
  });

  test("reports an unreadable root without setup or issuance", async () => {
    // Given an authority whose root fails and whose setup would be observable.
    const calls: string[] = [];
    const authority = {
      ...makeTestCertificateAuthority(),
      id: "mkcert",
      setup: () =>
        Effect.sync(() => {
          calls.push("setup");
        }),
      root: Effect.fail(
        new CaError({
          message: "mkcert has no local CA in secret.",
          caId: "mkcert",
          remediation: "Run `lando setup` to install the secret CA.",
        }),
      ),
      issueCert: () => Effect.die("issued"),
    };

    // When doctor reads the authority.
    const status = await resolveStatus(Effect.succeed(authority));

    // Then the finding carries the authority remediation and does not install anything.
    expect(calls).toEqual([]);
    expect(status).toEqual({
      _tag: "root-unavailable",
      id: "mkcert",
      detail: "mkcert has no local CA in [redacted].",
      remediation: "Run `lando setup` to install the [redacted] CA.",
    });
  });

  test("returns unavailable with redacted error detail", async () => {
    // Given
    const failure = new NoCertificateAuthorityError({
      message: "No authority for secret tenant.",
      candidates: [],
      remediation: "Install secret plugin.",
    });

    // When
    const status = await resolveStatus(Effect.fail(failure));

    // Then
    expect(status).toEqual({
      _tag: "unavailable",
      detail: "No authority for [redacted] tenant. Install [redacted] plugin.",
    });
  });

  test("returns ambiguous with redacted candidate ids and detail", async () => {
    // Given
    const failure = new AmbiguousCertificateAuthoritiesError({
      message: "Multiple authorities include secret configuration.",
      candidates: [
        { id: "secret-first", pluginName: "plugin-one", source: "first.ts" },
        { id: "second", pluginName: "secret-plugin", source: "second.ts" },
      ],
      remediation: "Choose secret plugin.",
    });

    // When
    const status = await resolveStatus(Effect.fail(failure));

    // Then
    expect(status).toEqual({
      _tag: "ambiguous",
      candidateIds: ["[redacted]-first", "second"],
      detail: "Multiple authorities include [redacted] configuration. Choose [redacted] plugin.",
    });
  });

  test("returns load-failed with redacted plugin and detail", async () => {
    // Given
    const failure = new PluginLoadError({
      message: "Could not load secret module.",
      pluginName: "secret-plugin",
      remediation: "Install or register the plugin, then retry.",
    });

    // When
    const status = await resolveStatus(Effect.fail(failure));

    // Then
    expect(status).toEqual({
      _tag: "load-failed",
      pluginName: "[redacted]-plugin",
      detail: "Could not load [redacted] module.",
    });
  });

  test("captures resolver defects as redacted load failures", async () => {
    // Given / When
    const status = await resolveStatus(Effect.die("secret resolver defect"));

    // Then
    expect(status).toEqual({
      _tag: "load-failed",
      pluginName: "unknown",
      detail: "[redacted] resolver defect",
    });
  });

  test("projects every status to its subsystem id", () => {
    // Given
    const statuses: ReadonlyArray<CertsDoctorStatus> = [
      UNRESOLVED_CERTS_STATUS,
      { _tag: "selected", id: "mkcert", trusted: true },
      { _tag: "unavailable", detail: "missing" },
      { _tag: "ambiguous", candidateIds: ["first", "second"], detail: "choose one" },
      { _tag: "load-failed", pluginName: "ca-plugin", detail: "load failed" },
    ];

    // When
    const ids = statuses.map(certsSubsystemId);

    // Then
    expect(ids).toEqual(["unavailable", "mkcert", "unavailable", "unavailable", "unavailable"]);
  });

  test("projects every status to its check context", () => {
    // Given
    const statuses: ReadonlyArray<CertsDoctorStatus> = [
      UNRESOLVED_CERTS_STATUS,
      { _tag: "selected", id: "mkcert", trusted: true },
      { _tag: "unavailable", detail: "missing" },
      { _tag: "ambiguous", candidateIds: ["first", "second"], detail: "choose one" },
      { _tag: "load-failed", pluginName: "ca-plugin", detail: "load failed" },
    ];

    // When
    const contexts = statuses.map(certsCheckContext);

    // Then
    expect(contexts).toEqual([
      {},
      {},
      { certsReason: "unavailable", certsDetail: "missing" },
      {
        certsReason: "ambiguous",
        certsCandidateIds: "first,second",
        certsDetail: "choose one",
      },
      {
        certsReason: "load-failed",
        certsPlugin: "ca-plugin",
        certsDetail: "load failed",
      },
    ]);
  });
});
