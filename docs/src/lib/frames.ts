import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type PublicTranscriptViewFrame,
  decodePublicTranscriptEither,
  toPublicTranscriptView,
} from "@lando/core/docs/render";
import { Either } from "effect";

import {
  type TranscriptFrameKey,
  type TranscriptRequest,
  findTranscriptFrame,
  placeholderFor,
  transcriptPathFor,
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

const transcriptRoots = [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")].map(
  (root) => resolve(root, "dist", "transcripts", "public", "guides"),
);

const transcriptRootFor = (request: TranscriptRequest): string => {
  for (const root of transcriptRoots) {
    if (existsSync(resolve(root, request.guideId))) return root;
  }
  return transcriptRoots[0] ?? resolve("dist", "transcripts", "public", "guides");
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
  const sourceLine =
    typeof sourceLineValue === "number"
      ? sourceLineValue
      : typeof sourceLineValue === "string"
        ? Number(sourceLineValue)
        : Number.NaN;
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

  let input: unknown;
  try {
    input = JSON.parse(await readFile(transcriptPathFor(request, transcriptRootFor(request)), "utf8"));
  } catch {
    return { status: "missing", reason: "transcript", label };
  }
  const decoded = decodePublicTranscriptEither(input);
  if (Either.isLeft(decoded)) return { status: "missing", reason: "transcript", label };

  const frame = findTranscriptFrame(toPublicTranscriptView(decoded.right), key);
  if (frame !== undefined) return { status: "captured", frame };

  return { status: "missing", reason: "frame", label };
};
