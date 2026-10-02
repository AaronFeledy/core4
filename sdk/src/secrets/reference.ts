import { Either, Schema } from "effect";

import { SecretReferenceInvalidError } from "../errors/secret.ts";

const ParsedSecretReference = Schema.Struct({
  raw: Schema.String,
  scheme: Schema.optional(Schema.String),
  key: Schema.String,
});

export type ParsedSecretReference = typeof ParsedSecretReference.Type;

export const parseSecretReference = (
  raw: string,
): Either.Either<ParsedSecretReference, SecretReferenceInvalidError> => {
  const invalid = () =>
    Either.left(
      new SecretReferenceInvalidError({
        message: "Invalid secret reference.",
        reference: raw,
        remediation:
          "Use a bare secret id or scheme://path with two to four nonempty segments and an optional ?attribute=value query.",
      }),
    );
  if (raw.trim() !== raw || raw === "..") return invalid();
  if (/^[A-Za-z0-9_.-]+$/.test(raw)) return Either.right({ raw, key: raw });

  const separator = raw.indexOf("://");
  if (separator < 0) return invalid();
  const scheme = raw.slice(0, separator);
  const key = raw.slice(separator + 3);
  if (!/^[a-z][a-z0-9-]*$/.test(scheme)) return invalid();

  const queryStart = key.indexOf("?");
  const path = queryStart < 0 ? key : key.slice(0, queryStart);
  if (queryStart >= 0 && !/^\?[a-z][a-z0-9-]*=[A-Za-z0-9_.-]+$/.test(key.slice(queryStart))) return invalid();
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.length > 4 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9 _.-]+$/.test(segment) || segment.trim().length === 0 || segment.trim() === "..",
    )
  )
    return invalid();

  return Either.right({ raw, scheme, key });
};
