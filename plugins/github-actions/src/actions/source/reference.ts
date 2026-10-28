import { Effect, Schema } from "effect";
import { type LanguageSource, LanguageSourceSchema } from "../../language/errors.ts";
import { snapshotSourceJson } from "./admission.ts";
import { sourceError } from "./errors.ts";

export interface ActionSourcePolicy {
  readonly pinOnly?: boolean;
  readonly origin?: string;
  readonly allowedOrigins?: readonly string[];
}
interface Located {
  readonly source: LanguageSource;
}
export interface LocalActionReference extends Located {
  readonly kind: "local";
  readonly path: string;
}
export interface RepositoryActionReference extends Located {
  readonly kind: "repository";
  readonly origin: string;
  readonly repository: string;
  readonly subpath: string;
  readonly requestedRef: string;
  readonly commit?: string;
}
export interface DockerActionReference extends Located {
  readonly kind: "docker";
  readonly image: string;
  readonly digest?: string;
}
export type ActionReference = LocalActionReference | RepositoryActionReference | DockerActionReference;
export interface ResolvedRepositoryReference extends RepositoryActionReference {
  readonly commit: string;
  readonly provenance: "immutable-pin" | "trusted-fixture";
}
export interface TrustedFixtureResolution {
  readonly origin: string;
  readonly repository: string;
  readonly requestedRef: string;
  readonly commit: string;
  readonly provenance: "trusted-fixture";
}
const PolicySchema = Schema.Struct({
  pinOnly: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(Schema.String),
  allowedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
});
const ReferenceSchema = Schema.Struct({
  kind: Schema.Literal("repository"),
  origin: Schema.String,
  repository: Schema.String,
  subpath: Schema.String,
  requestedRef: Schema.String,
  commit: Schema.optionalKey(Schema.String),
  source: LanguageSourceSchema,
});
const ResolutionSchema = Schema.Struct({
  origin: Schema.String,
  repository: Schema.String,
  requestedRef: Schema.String,
  commit: Schema.String,
  provenance: Schema.Literal("trusted-fixture"),
});
const commitPattern = /^[a-fA-F0-9]{40}$/u;
const forbidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s\\%?#]/u;
// A portable repository-relative path has no encoded or platform-specific interpretation.
export const validSourcePath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 1024 &&
  !forbidden.test(path) &&
  path.split("/").every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..");
const canonicalOrigin = (origin: string): string | undefined => {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/u.test(origin)) return undefined;
  try {
    const url = new URL(origin);
    if (url.hostname.startsWith(".") || url.hostname.endsWith(".") || url.hostname.includes(".."))
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};
export const parseActionReference = Effect.fn("ActionSource.parseReference")(function* (
  text: string,
  sourceInput: LanguageSource,
  policyInput: ActionSourcePolicy = {},
) {
  const admitted = yield* Effect.try({
    try: () => ({
      source: Schema.decodeUnknownSync(LanguageSourceSchema)(snapshotSourceJson(sourceInput)),
      policy: Schema.decodeUnknownSync(PolicySchema)(snapshotSourceJson(policyInput)),
    }),
    catch: () => sourceError("invalid-reference", { file: "action-source" }),
  });
  const { source, policy } = admitted;
  if (typeof text !== "string" || text.length === 0 || text.length > 2048 || forbidden.test(text))
    return yield* sourceError("invalid-reference", source);
  if (text.startsWith("./")) {
    const path = text.slice(2);
    if (!validSourcePath(path)) return yield* sourceError("invalid-reference", source);
    return { kind: "local", path, source } satisfies LocalActionReference;
  }
  if (text.startsWith("docker://")) {
    const image = text.slice(9);
    // A Docker image is data only; provider artifact acquisition remains execution-owned.
    const parts =
      /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@(sha256:[a-f0-9]{64}))?$/u.exec(
        image,
      );
    if (parts === null) return yield* sourceError("invalid-reference", source);
    const digest = parts[1];
    if (policy.pinOnly && digest === undefined) return yield* sourceError("pin-required", source);
    return {
      kind: "docker",
      image,
      ...(digest === undefined ? {} : { digest }),
      source,
    } satisfies DockerActionReference;
  }
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return yield* sourceError("invalid-reference", source);
  const path = text.slice(0, at);
  const requestedRef = text.slice(at + 1);
  const [owner, repo, ...subpath] = path.split("/");
  if (
    owner === undefined ||
    repo === undefined ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(repo) ||
    repo.toLowerCase().endsWith(".git") ||
    !validSourcePath(path) ||
    !validSourcePath(requestedRef) ||
    requestedRef.includes("..") ||
    requestedRef.endsWith(".") ||
    requestedRef.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    return yield* sourceError("invalid-reference", source);
  const origin = canonicalOrigin(policy.origin ?? "https://github.com");
  if (origin === undefined) return yield* sourceError("invalid-reference", source);
  if (
    policy.allowedOrigins !== undefined &&
    !policy.allowedOrigins.some((allowed) => canonicalOrigin(allowed) === origin)
  )
    return yield* sourceError("policy-denied", source);
  const commit = commitPattern.test(requestedRef) ? requestedRef.toLowerCase() : undefined;
  if (policy.pinOnly && commit === undefined) return yield* sourceError("pin-required", source);
  return {
    kind: "repository",
    origin,
    repository: `${owner}/${repo}`.toLowerCase(),
    subpath: subpath.join("/"),
    requestedRef,
    ...(commit === undefined ? {} : { commit }),
    source,
  } satisfies RepositoryActionReference;
});
export const resolveFixtureReference = Effect.fn("ActionSource.resolveFixtureReference")(function* (
  referenceInput: RepositoryActionReference,
  resolutionInput?: TrustedFixtureResolution,
) {
  const admitted = yield* Effect.try({
    try: () => ({
      reference: Schema.decodeUnknownSync(ReferenceSchema)(snapshotSourceJson(referenceInput)),
      resolution:
        resolutionInput === undefined
          ? undefined
          : Schema.decodeUnknownSync(ResolutionSchema)(snapshotSourceJson(resolutionInput)),
    }),
    catch: () => sourceError("invalid-reference", { file: "action-source" }),
  });
  const { reference, resolution } = admitted;
  if (reference.commit !== undefined)
    return {
      ...reference,
      commit: reference.commit,
      provenance: "immutable-pin" as const,
    } satisfies ResolvedRepositoryReference;
  if (resolution === undefined) return yield* sourceError("resolver-required", reference.source);
  if (resolution.origin !== reference.origin) return yield* sourceError("origin-mismatch", reference.source);
  if (
    resolution.repository !== reference.repository ||
    resolution.requestedRef !== reference.requestedRef ||
    !commitPattern.test(resolution.commit) ||
    resolution.provenance !== "trusted-fixture"
  )
    return yield* sourceError("integrity-mismatch", reference.source);
  return {
    ...reference,
    commit: resolution.commit.toLowerCase(),
    provenance: "trusted-fixture" as const,
  } satisfies ResolvedRepositoryReference;
});
