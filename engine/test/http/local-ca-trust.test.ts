import { describe, expect, test } from "bun:test";
import { isLocalProbeHost } from "@lando/http-client/local-ca-trust";
import { CertificateAuthority } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

import { LOCAL_CA_UNTRUSTED_CODE, layer, warnIfLocalCaUntrusted } from "../../src/http/local-ca-trust.ts";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";

const authority = (trusted: boolean) =>
  CertificateAuthority.of({
    id: "mkcert",
    setup: () => Effect.void,
    root: Effect.succeed({ certificate: "pem", trusted }),
    issueCert: () => Effect.die("issue"),
  });

const provide = (trusted: boolean) =>
  Layer.succeed(
    CertificateAuthorityResolver,
    CertificateAuthorityResolver.of({ resolve: Effect.succeed(authority(trusted)) }),
  );

describe("local CA trust", () => {
  test("isLocalProbeHost accepts loopback and the proxy domain only", () => {
    expect(isLocalProbeHost("web.app.lndo.site", "lndo.site")).toBe(true);
    expect(isLocalProbeHost("127.0.0.1", "lndo.site")).toBe(true);
    expect(isLocalProbeHost("example.com", "lndo.site")).toBe(false);
    expect(isLocalProbeHost("notlndo.site", "lndo.site")).toBe(false);
  });

  test("warns once when a local HTTPS URL was checked and the host does not trust the CA", async () => {
    const warnings = makeCommandWarnings(true);
    await Effect.runPromise(
      warnIfLocalCaUntrusted([
        { url: "https://web.app.lndo.site/" },
        { url: "https://web.app.lndo.site/again" },
      ]).pipe(
        Effect.provide(layer),
        Effect.provide(provide(false)),
        Effect.provideService(CommandWarnings, warnings),
      ),
    );
    const recorded = await Effect.runPromise(warnings.list);
    expect(recorded.map((warning) => warning.code)).toEqual([LOCAL_CA_UNTRUSTED_CODE]);
    expect(recorded[0]?.remediation).toContain("--skip-install-ca");
  });

  test("does not warn for a public URL or a trusted local CA", async () => {
    const warnings = makeCommandWarnings(true);
    await Effect.runPromise(
      warnIfLocalCaUntrusted([{ url: "https://example.com/" }]).pipe(
        Effect.provide(layer),
        Effect.provide(provide(false)),
        Effect.provideService(CommandWarnings, warnings),
      ),
    );
    await Effect.runPromise(
      warnIfLocalCaUntrusted([{ url: "https://web.app.lndo.site/" }]).pipe(
        Effect.provide(layer),
        Effect.provide(provide(true)),
        Effect.provideService(CommandWarnings, warnings),
      ),
    );
    expect(await Effect.runPromise(warnings.list)).toEqual([]);
  });
});
