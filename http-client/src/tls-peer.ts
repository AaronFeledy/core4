import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, connect } from "node:tls";
import { Effect, Schema } from "effect";

const Target = Schema.Struct({
  hostname: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.makeFilter(
      (name) =>
        isIP(name) !== 0 ||
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(name),
    ),
  ),
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })),
  address: Schema.String.check(Schema.makeFilter((address) => isIP(address) !== 0)),
});

export const TlsPeerInput = Schema.Struct({
  ...Target.fields,
  caPems: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
});
export type TlsPeerInput = typeof TlsPeerInput.Type;

/** Carries only validated target coordinates and fixed diagnostics, never raw TLS errors or PEMs. */
export class TlsPeerError extends Schema.TaggedError<TlsPeerError>()("TlsPeerError", {
  reason: Schema.Literals(["invalid-target", "invalid-trust", "handshake", "peer-unavailable", "timeout"]),
  target: Schema.optionalKey(Target),
  message: Schema.String,
  remediation: Schema.NonEmptyString,
}) {}

/** One direct TLS handshake, using only the supplied IP and CA trust; returns the public leaf PEM. */
export const observeTlsPeer = Effect.fn("HttpClient.observeTlsPeer")(function* (
  input: TlsPeerInput,
): Effect.fn.Return<string, TlsPeerError> {
  const target = yield* Schema.decodeUnknownEffect(Target)(input).pipe(
    Effect.catch(() =>
      Effect.fail(
        new TlsPeerError({
          reason: "invalid-target",
          message: "Invalid TLS peer target",
          remediation: "Supply a concrete hostname, a port from 1 to 65535, and a pinned IP address.",
        }),
      ),
    ),
  );
  const invalidTrust = () =>
    new TlsPeerError({
      reason: "invalid-trust",
      target,
      message: "Invalid explicit TLS peer trust",
      remediation: "Supply at least one valid CA certificate PEM.",
    });
  const ca = yield* Schema.decodeUnknownEffect(TlsPeerInput.fields.caPems)(input.caPems).pipe(
    Effect.catch(() => Effect.fail(invalidTrust())),
    Effect.flatMap((pems) =>
      Effect.try({
        try: () => pems.map((pem) => new X509Certificate(pem).toString()),
        catch: invalidTrust,
      }),
    ),
  );
  const failure = (reason: "handshake" | "peer-unavailable" | "timeout") =>
    new TlsPeerError({
      reason,
      target,
      message: "TLS peer observation failed",
      remediation: "Check the pinned listener, its hostname certificate, and the supplied signing CA.",
    });
  return yield* Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          connect({
            host: target.address,
            port: target.port,
            servername: isIP(target.hostname) === 0 ? target.hostname : "",
            ca,
            rejectUnauthorized: true,
            checkServerIdentity: (
              _hostname: string,
              certificate: Parameters<typeof checkServerIdentity>[1],
            ) => checkServerIdentity(target.hostname, certificate),
          }),
        catch: () => failure("handshake"),
      }),
      (socket) =>
        Effect.sync(() => {
          socket.destroy();
        }),
    );
    return yield* Effect.callback<string, TlsPeerError>((resume) => {
      socket.once("error", () => resume(Effect.fail(failure("handshake"))));
      socket.once("close", () => resume(Effect.fail(failure("peer-unavailable"))));
      socket.once("secureConnect", () => {
        resume(
          Effect.try({
            try: () => new X509Certificate(socket.getPeerCertificate().raw).toString(),
            catch: () => failure("peer-unavailable"),
          }),
        );
      });
    });
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(failure("timeout")) }),
  );
});
