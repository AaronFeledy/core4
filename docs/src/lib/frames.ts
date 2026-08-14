import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type PublicTranscriptViewFrame, assertHttpsSourceLinkBase } from "@lando/core/docs/render";

import {
  DEFAULT_PUBLIC_TRANSCRIPT_ROOT,
  type TranscriptFrameKey,
  type TranscriptRequest,
  findTranscriptFrame,
  placeholderFor,
  resolveTranscript,
} from "./transcripts.ts";

export type FrameKind = PublicTranscriptViewFrame["kind"];

export type ComponentFrameResolution =
  | { readonly status: "captured"; readonly frame: PublicTranscriptViewFrame }
  | {
      readonly status: "missing";
      readonly reason: "context" | "transcript" | "frame";
      readonly label: string;
    };

type ComponentProps = Readonly<Record<string, unknown>>;

export const DEFAULT_SOURCE_LINK_BASE = "https://github.com/lando-community/core4/blob/main";

const envValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value : undefined;
};

/** Last validated override — revalidated only when the env string changes. */
let validatedSourceLinkBaseOverride: { readonly raw: string; readonly value: string } | undefined;

const resolvedSourceLinkBase = (): string => {
  const override = envValue("LANDO_DOCS_SOURCE_LINK_BASE");
  if (override === undefined) return DEFAULT_SOURCE_LINK_BASE;
  if (validatedSourceLinkBaseOverride?.raw === override) return validatedSourceLinkBaseOverride.value;
  const value = assertHttpsSourceLinkBase(override);
  validatedSourceLinkBaseOverride = { raw: override, value };
  return value;
};

const transcriptRootIn = (base: string) => resolve(base, "dist", "transcripts", "public", "guides");

/** Successful discoveries only, keyed by cwd + guideId. Misses are never stored. */
const transcriptRootCache = new Map<string, string>();

const transcriptRootCacheKey = (cwd: string, guideId: string): string => `${cwd}\0${guideId}`;
const discoverTranscriptRoot = (guideId: string): string => {
  const override = envValue("LANDO_DOCS_TRANSCRIPT_ROOT");
  if (override !== undefined) return override;

  const candidates = [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")].map(
    (root) => resolve(root, "dist", "transcripts", "public", "guides"),
  );
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, guideId))) return candidate;
  }
  return candidates[0] ?? DEFAULT_PUBLIC_TRANSCRIPT_ROOT;
};

const stringProp = (props: ComponentProps, name: string): string | undefined => {
  const value = props[name];
  return typeof value === "string" ? value : undefined;
};

export const transcriptRequestFor = (props: ComponentProps): TranscriptRequest | undefined => {
  const guideId = stringProp(props, "data-guide-id");
  const scenarioId = stringProp(props, "data-scenario-id");
  if (guideId === undefined || scenarioId === undefined) return undefined;
  return { guideId, scenarioId, variant: stringProp(props, "data-variant") ?? "" };
};

export const frameKeyFor = (props: ComponentProps, kind: FrameKind): TranscriptFrameKey | undefined => {
  const sourceFile = stringProp(props, "data-source-file");
  const sourceLineValue = props["data-source-line"];
  if (sourceFile === undefined) return undefined;
  let sourceLine: number;
  if (typeof sourceLineValue === "number") {
    sourceLine = sourceLineValue;
  } else if (typeof sourceLineValue === "string") {
    sourceLine = Number(sourceLineValue);
  } else {
    sourceLine = Number.NaN;
  }
  if (!Number.isInteger(sourceLine) || sourceLine < 1) return undefined;
  return { kind, sourceFile, sourceLine };
};

export const resolveComponentFrame = async (
  props: ComponentProps,
  kind: FrameKind,
  commandText = "",
): Promise<ComponentFrameResolution> => {
  const request = transcriptRequestFor(props);
  const key = frameKeyFor(props, kind);
  const label = placeholderFor({ commandText }).label;
  if (request === undefined || key === undefined) return { status: "missing", reason: "context", label };

  const resolved = await resolveTranscript(request, {
    root: discoverTranscriptRoot(request.guideId),
    sourceLinkBase: resolvedSourceLinkBase(),
  });
  if (resolved.kind === "missing") return { status: "missing", reason: "transcript", label };

  const frame = findTranscriptFrame(resolved.view, key);
  if (frame !== undefined) return { status: "captured", frame };

  return { status: "missing", reason: "frame", label };
};
