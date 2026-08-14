import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type PublicTranscriptView,
  type PublicTranscriptViewFrame,
  decodePublicTranscriptEither,
  toPublicTranscriptView,
} from "@lando/core/docs/render";
import type { PublicTranscript } from "@lando/core/schema";
import { AxisToken, ComponentId, GuideId } from "@lando/sdk/docs/components";
import { Either, Schema } from "effect";

export type TranscriptRequest = {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
};

export type TranscriptReadFile = (path: string) => Promise<string>;

export type TranscriptResolverOptions = {
  readonly root?: string;
  readonly sourceLinkBase?: string;
  /** Narrow injectable read seam for tests; defaults to node:fs/promises readFile. */
  readonly readFile?: TranscriptReadFile;
};

export type TranscriptWarning = {
  readonly code: "transcript.invalid-json" | "transcript.invalid-schema" | "transcript.unreadable";
  readonly message: string;
  readonly path: string;
};

export type ResolvedTranscript = {
  readonly kind: "ok";
  readonly path: string;
  readonly request: TranscriptRequest;
  readonly transcript: PublicTranscript;
  readonly view: PublicTranscriptView;
};

export type MissingTranscript =
  | {
      readonly kind: "missing";
      readonly path: string;
      readonly reason: "absent";
      readonly request: TranscriptRequest;
    }
  | {
      readonly kind: "missing";
      readonly path: string;
      readonly reason: "invalid";
      readonly request: TranscriptRequest;
      readonly warning: TranscriptWarning;
    };

export type TranscriptResolution = ResolvedTranscript | MissingTranscript;

export type TranscriptFrameKey = Pick<PublicTranscriptViewFrame, "kind" | "sourceFile" | "sourceLine">;

export type TranscriptPlaceholderRequest = {
  readonly commandText: string;
};

export type TranscriptPlaceholder = {
  readonly commandText: string;
  readonly label: string;
};

type CachedTranscript =
  | { readonly kind: "ok"; readonly transcript: PublicTranscript }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly warning: TranscriptWarning };

export const DEFAULT_PUBLIC_TRANSCRIPT_ROOT = fileURLToPath(
  new URL("../../../dist/transcripts/public/guides", import.meta.url),
);

const MISSING_TRANSCRIPT_LABEL = "No captured output yet" as const;
const transcriptCache = new Map<string, Promise<CachedTranscript>>();

const isPathInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Axis names and values use the canonical AxisToken contract. */
const isSafeAxisToken = (token: string): boolean => Schema.is(AxisToken)(token);

export const isSafeTranscriptRequest = (request: TranscriptRequest): boolean => {
  if (!Schema.is(GuideId)(request.guideId)) return false;
  if (!Schema.is(ComponentId)(request.scenarioId)) return false;
  if (request.variant === "") return true;
  if (request.variant.includes("\0")) return false;
  if (request.variant.includes("/") || request.variant.includes("\\")) return false;

  const seenAxes = new Set<string>();
  for (const pair of request.variant.split(" ")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) return false;
    // Reject multi-`=` values so suffix segments stay parseable (`axis=value` only).
    if (pair.indexOf("=", separator + 1) !== -1) return false;
    const axis = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!isSafeAxisToken(axis) || !isSafeAxisToken(value)) return false;
    if (seenAxes.has(axis)) return false;
    seenAxes.add(axis);
  }
  return true;
};

export const transcriptPathFor = (
  request: TranscriptRequest,
  root = DEFAULT_PUBLIC_TRANSCRIPT_ROOT,
): string | undefined => {
  if (!isSafeTranscriptRequest(request)) return undefined;

  const suffix = variantFileSuffix(request.variant);
  const candidate = resolve(root, request.guideId, `${request.scenarioId}${suffix}.json`);
  if (!isPathInsideRoot(root, candidate)) return undefined;
  return candidate;
};

const isAbsent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const defaultReadFile: TranscriptReadFile = (path) => readFile(path, "utf8");

const loadTranscript = async (
  path: string,
  read: TranscriptReadFile = defaultReadFile,
): Promise<CachedTranscript> => {
  try {
    const decoded = decodePublicTranscriptEither(JSON.parse(await read(path)));
    if (Either.isLeft(decoded)) {
      return {
        kind: "invalid",
        warning: {
          code: "transcript.invalid-schema",
          message: `Public transcript does not match its schema: ${path}`,
          path,
        },
      };
    }

    return { kind: "ok", transcript: decoded.right };
  } catch (error) {
    if (isAbsent(error)) return { kind: "absent" };
    if (error instanceof SyntaxError) {
      return {
        kind: "invalid",
        warning: {
          code: "transcript.invalid-json",
          message: `Public transcript contains invalid JSON: ${path}`,
          path,
        },
      };
    }

    const detail = error instanceof Error ? ` (${error.message})` : "";
    return {
      kind: "invalid",
      warning: {
        code: "transcript.unreadable",
        message: `Public transcript could not be read: ${path}${detail}`,
        path,
      },
    };
  }
};

const cachedTranscriptFor = (
  path: string,
  read: TranscriptReadFile = defaultReadFile,
): Promise<CachedTranscript> => {
  const cached = transcriptCache.get(path);
  if (cached !== undefined) return cached;

  // In-flight only: drop the entry once the promise settles so later disk
  // creates/deletes/rewrites are visible without a permanent result cache.
  const pending = loadTranscript(path, read).finally(() => {
    if (transcriptCache.get(path) === pending) {
      transcriptCache.delete(path);
    }
  });
  transcriptCache.set(path, pending);
  return pending;
};

export const resolveTranscript = async (
  request: TranscriptRequest,
  options?: TranscriptResolverOptions,
): Promise<TranscriptResolution> => {
  const root = options?.root ?? DEFAULT_PUBLIC_TRANSCRIPT_ROOT;
  const path = transcriptPathFor(request, root);
  if (path === undefined) {
    return {
      kind: "missing",
      path: resolve(root, "__unsafe-request__"),
      reason: "absent",
      request,
    };
  }

  try {
    const cached = await cachedTranscriptFor(path, options?.readFile ?? defaultReadFile);
    switch (cached.kind) {
      case "ok": {
        const view =
          options?.sourceLinkBase === undefined
            ? toPublicTranscriptView(cached.transcript)
            : toPublicTranscriptView(cached.transcript, { sourceLinkBase: options.sourceLinkBase });
        return { kind: "ok", path, request, transcript: cached.transcript, view };
      }
      case "absent":
        return { kind: "missing", path, reason: "absent", request };
      case "invalid":
        return { kind: "missing", path, reason: "invalid", request, warning: cached.warning };
      default: {
        const exhaustive: never = cached;
        throw new TypeError(`Unexpected cached transcript result: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    return {
      kind: "missing",
      path,
      reason: "invalid",
      request,
      warning: {
        code: "transcript.unreadable",
        message: `Public transcript could not be resolved: ${path}${detail}`,
        path,
      },
    };
  }
};

export const findTranscriptFrame = (
  view: PublicTranscriptView,
  key: TranscriptFrameKey,
): PublicTranscriptViewFrame | undefined =>
  view.frames.find(
    (frame) =>
      frame.kind === key.kind && frame.sourceFile === key.sourceFile && frame.sourceLine === key.sourceLine,
  );

export const placeholderFor = (request: TranscriptPlaceholderRequest): TranscriptPlaceholder => ({
  commandText: request.commandText,
  label: MISSING_TRANSCRIPT_LABEL,
});
