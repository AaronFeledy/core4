import { Effect } from "effect";

import { ComposeKeyRejectedError, LandofileParseError } from "@lando/sdk/errors";
import { type LandofileTagOccurrence, detectLandofileTags } from "../parser.ts";
import {
  type ComposeDisposition,
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "./dispositions.ts";
import { type DispositionTrieNode, compileDispositionTrie, matchDispositionChild } from "./rejection-trie.ts";

export interface ComposeRejectionMatch {
  readonly matrixPath: string;
  readonly documentPath: string;
  readonly service?: string;
  readonly rationale: string;
  readonly remediation: string;
}

export interface ComposeDispositionMatch {
  readonly matrixPath: string;
  readonly documentPath: string;
  readonly service?: string;
  readonly disposition: ComposeDisposition;
  readonly rationale: string;
  readonly remediation?: string;
}

class ComposeRejectionMatrixInvariantError extends Error {
  override readonly name = "ComposeRejectionMatrixInvariantError";

  constructor(matrixPath: string) {
    super(`Rejected Compose disposition ${matrixPath} must include remediation.`);
  }
}

let serviceDispositionTrie: DispositionTrieNode | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejectedEntry = (
  entry: ComposeDispositionEntry,
  matrixPath: string,
): (ComposeDispositionEntry & { readonly remediation: string }) | undefined => {
  switch (entry.disposition) {
    case "normalized":
    case "preserved":
      return undefined;
    case "rejected":
      if (entry.remediation === undefined) throw new ComposeRejectionMatrixInvariantError(matrixPath);
      return { ...entry, remediation: entry.remediation };
    default: {
      const exhaustive: never = entry.disposition;
      throw new ComposeRejectionMatrixInvariantError(String(exhaustive));
    }
  }
};

interface MatchLocation {
  readonly matrixPath: string;
  readonly documentPath: string;
  readonly service?: string;
}

const dispositionMatch = (
  entry: ComposeDispositionEntry,
  location: MatchLocation,
): ComposeDispositionMatch => {
  const match = {
    matrixPath: location.matrixPath,
    documentPath: location.documentPath,
    disposition: entry.disposition,
    rationale: entry.rationale,
  };
  switch (entry.disposition) {
    case "normalized":
    case "preserved":
      return location.service === undefined ? match : { ...match, service: location.service };
    case "rejected": {
      if (entry.remediation === undefined) {
        throw new ComposeRejectionMatrixInvariantError(location.matrixPath);
      }
      const rejectedMatch = { ...match, remediation: entry.remediation };
      return location.service === undefined ? rejectedMatch : { ...rejectedMatch, service: location.service };
    }
    default: {
      const exhaustive: never = entry.disposition;
      throw new ComposeRejectionMatrixInvariantError(String(exhaustive));
    }
  }
};

const matchForNode = (
  node: DispositionTrieNode,
  location: Omit<MatchLocation, "matrixPath">,
): ComposeDispositionMatch | undefined => {
  if (node.entry === undefined || node.matrixPath === undefined) return undefined;
  return dispositionMatch(node.entry, { ...location, matrixPath: node.matrixPath });
};

interface WalkContext {
  readonly documentPath: string;
  readonly service?: string;
  readonly matches: ComposeDispositionMatch[];
}

const walkValue = (value: unknown, node: DispositionTrieNode, context: WalkContext): void => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkValue(item, node, { ...context, documentPath: `${context.documentPath}[${index}]` });
    }
    return;
  }
  if (!isRecord(value)) return;
  if (node.matrixPath === "build" && ("artifact" in value || "app" in value)) return;

  for (const key of Object.keys(value)) {
    const child = matchDispositionChild(node, key);
    if (child === undefined) continue;
    const documentPath = `${context.documentPath}.${key}`;
    const match = matchForNode(child, {
      documentPath,
      ...(context.service === undefined ? {} : { service: context.service }),
    });
    if (match !== undefined) {
      context.matches.push(match);
      switch (match.disposition) {
        case "normalized":
        case "preserved":
          break;
        case "rejected":
          continue;
        default: {
          const exhaustive: never = match.disposition;
          throw new ComposeRejectionMatrixInvariantError(String(exhaustive));
        }
      }
    }
    walkValue(value[key], child, { ...context, documentPath });
  }
};

const walkServices = (value: unknown, matches: ComposeDispositionMatch[]): void => {
  if (!isRecord(value)) return;
  serviceDispositionTrie ??= compileDispositionTrie(composeServiceDispositions);
  for (const service of Object.keys(value)) {
    walkValue(value[service], serviceDispositionTrie, {
      documentPath: `services.${service}`,
      service,
      matches,
    });
  }
};

export const analyzeComposeDispositions = (parsed: unknown): ReadonlyArray<ComposeDispositionMatch> => {
  if (!isRecord(parsed)) return [];
  const matches: ComposeDispositionMatch[] = [];
  for (const key of Object.keys(parsed)) {
    const matrixPath = key.startsWith("x-") ? "x-*" : key;
    const entry = composeTopLevelDispositions[matrixPath];
    if (entry === undefined) continue;
    const match = dispositionMatch(entry, {
      matrixPath,
      documentPath: key,
    });
    matches.push(match);
    switch (match.disposition) {
      case "normalized":
      case "preserved":
        break;
      case "rejected":
        continue;
      default: {
        const exhaustive: never = match.disposition;
        throw new ComposeRejectionMatrixInvariantError(String(exhaustive));
      }
    }
    if (key === "services") walkServices(parsed[key], matches);
  }
  return matches;
};

export const analyzeComposeRejections = (parsed: unknown): ReadonlyArray<ComposeRejectionMatch> => {
  const rejections: ComposeRejectionMatch[] = [];
  for (const match of analyzeComposeDispositions(parsed)) {
    switch (match.disposition) {
      case "normalized":
      case "preserved":
        continue;
      case "rejected": {
        if (match.remediation === undefined) {
          throw new ComposeRejectionMatrixInvariantError(match.matrixPath);
        }
        const rejection = {
          matrixPath: match.matrixPath,
          documentPath: match.documentPath,
          rationale: match.rationale,
          remediation: match.remediation,
        };
        rejections.push(match.service === undefined ? rejection : { ...rejection, service: match.service });
        break;
      }
      default: {
        const exhaustive: never = match.disposition;
        throw new ComposeRejectionMatrixInvariantError(String(exhaustive));
      }
    }
  }
  return rejections;
};

export const firstComposeRejection = (parsed: unknown): ComposeRejectionMatch | undefined =>
  analyzeComposeRejections(parsed)[0];

export const composeTagRejection = (occurrence: LandofileTagOccurrence): ComposeRejectionMatch => {
  const entry = composeTagDispositions[occurrence.tag];
  const rejection = rejectedEntry(entry, occurrence.tag);
  if (rejection === undefined) throw new ComposeRejectionMatrixInvariantError(occurrence.tag);
  return {
    matrixPath: occurrence.tag,
    documentPath: occurrence.tag,
    rationale: rejection.rationale,
    remediation: rejection.remediation,
  };
};

export const composeKeyRejectedError = (args: {
  readonly source: string;
  readonly match: ComposeRejectionMatch;
}): ComposeKeyRejectedError =>
  new ComposeKeyRejectedError({
    message: `Compose key "${args.match.documentPath}" in ${args.source} is not supported by Lando: ${args.match.rationale}`,
    source: args.source,
    ...(args.match.service === undefined ? {} : { service: args.match.service }),
    keyPath: args.match.matrixPath,
    remediation: args.match.remediation,
  });

export const rejectComposeTags = (
  source: string,
  content: string,
): Effect.Effect<string, ComposeKeyRejectedError | LandofileParseError> =>
  Effect.try({
    try: () => detectLandofileTags({ content, file: source }),
    catch: (cause) => {
      if (cause instanceof LandofileParseError) return cause;
      throw cause;
    },
  }).pipe(
    Effect.flatMap((occurrences) => {
      const first = occurrences[0];
      return first === undefined
        ? Effect.succeed(content)
        : Effect.fail(composeKeyRejectedError({ source, match: composeTagRejection(first) }));
    }),
  );

export const rejectComposeKeys = (
  source: string,
  parsed: unknown,
): Effect.Effect<unknown, ComposeKeyRejectedError> => {
  const match = firstComposeRejection(parsed);
  return match === undefined
    ? Effect.succeed(parsed)
    : Effect.fail(composeKeyRejectedError({ source, match }));
};
