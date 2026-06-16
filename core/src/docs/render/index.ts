import { join } from "node:path";

import { PublicTranscript, type PublicTranscriptFrame } from "@lando/core/schema";
import { Either, type ParseResult, Schema } from "effect";

import { type RedactionEnvironment, redactPublicTranscript } from "./redaction.ts";

export {
  redactPublicTranscript,
  redactPublicTranscriptText,
  type RedactionEnvironment,
} from "./redaction.ts";

export const decodePublicTranscriptEither = (
  input: unknown,
): Either.Either<PublicTranscript, ParseResult.ParseError> =>
  Schema.decodeUnknownEither(PublicTranscript)(input);

export interface SourceLinkOptions {
  readonly sourceLinkBase?: string;
}

export interface RenderOptions extends SourceLinkOptions {
  readonly redactionEnv?: RedactionEnvironment;
}

const transcriptPathFor = (args: {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
}): string => {
  const suffix =
    args.variant === ""
      ? ""
      : `.${args.variant
          .split(" ")
          .map((pair) => pair.split("=")[1] ?? "")
          .join(".")}`;
  return join("dist", "transcripts", "public", "guides", args.guideId, `${args.scenarioId}${suffix}.json`);
};

export const frameSourceHref = (frame: PublicTranscriptFrame, options?: SourceLinkOptions): string => {
  const relativeHref = `${frame.sourceFile}#L${frame.sourceLine}`;
  const base = options?.sourceLinkBase;

  return typeof base === "string" && base.trim() !== ""
    ? `${base.replace(/\/+$/, "")}/${relativeHref}`
    : relativeHref;
};

export interface PublicTranscriptViewFrame {
  readonly kind: PublicTranscriptFrame["kind"];
  readonly displayText?: string;
  readonly commandDisplay?: string;
  readonly resultSummary?: string;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly sourceHref: string;
}

export interface PublicTranscriptView {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
  readonly runtime: string;
  readonly frames: ReadonlyArray<PublicTranscriptViewFrame>;
}

export const toPublicTranscriptView = (
  transcript: PublicTranscript,
  options?: RenderOptions,
): PublicTranscriptView => {
  const redacted = redactPublicTranscript(transcript, options?.redactionEnv);
  return {
    guideId: redacted.guideId,
    scenarioId: redacted.scenarioId,
    variant: redacted.variant,
    runtime: redacted.runtime,
    frames: redacted.frames.map((frame) => ({
      kind: frame.kind,
      ...(frame.displayText === undefined ? {} : { displayText: frame.displayText }),
      ...(frame.commandDisplay === undefined ? {} : { commandDisplay: frame.commandDisplay }),
      ...(frame.resultSummary === undefined ? {} : { resultSummary: frame.resultSummary }),
      sourceFile: frame.sourceFile,
      sourceLine: frame.sourceLine,
      sourceHref: frameSourceHref(frame, options),
    })),
  };
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const renderFrameHtml = (frame: PublicTranscriptViewFrame): string => {
  const display =
    frame.displayText === undefined
      ? ""
      : `<span class="lando-frame__display">${escapeHtml(frame.displayText)}</span>`;
  const command =
    frame.commandDisplay === undefined
      ? ""
      : `<code class="lando-frame__command">${escapeHtml(frame.commandDisplay)}</code>`;
  const result =
    frame.resultSummary === undefined
      ? ""
      : `<span class="lando-frame__result">${escapeHtml(frame.resultSummary)}</span>`;
  const sourceLabel = `${frame.sourceFile}:${frame.sourceLine}`;

  return `<div class="lando-frame lando-frame--${escapeHtml(frame.kind)}" data-source-file="${escapeHtml(frame.sourceFile)}" data-source-line="${frame.sourceLine}">${display}${command}${result}<a class="lando-frame__source" href="${escapeHtml(frame.sourceHref)}">${escapeHtml(sourceLabel)}</a></div>`;
};

export const renderPublicTranscriptHtml = (transcript: PublicTranscript, options?: RenderOptions): string => {
  const view = toPublicTranscriptView(transcript, options);
  const frames = view.frames.map(renderFrameHtml).join("");

  return `<div class="lando-transcript" data-guide-id="${escapeHtml(view.guideId)}" data-scenario-id="${escapeHtml(view.scenarioId)}" data-variant="${escapeHtml(view.variant)}" data-runtime="${escapeHtml(view.runtime)}">${frames}</div>`;
};

export const loadPublicTranscript = async (args: {
  readonly root: string;
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
}): Promise<PublicTranscript> => {
  const transcriptPath = join(args.root, transcriptPathFor(args));
  const input = await Bun.file(transcriptPath).json();
  const decoded = decodePublicTranscriptEither(input);

  if (Either.isLeft(decoded)) {
    throw new Error(`Failed to decode public transcript at ${transcriptPath}`);
  }

  return redactPublicTranscript(decoded.right);
};
