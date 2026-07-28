import { Effect } from "effect";

import { ComposeKeyRejectedError, LandofileParseError } from "../../errors/tagged.ts";
import { type LandofileTagOccurrence, detectLandofileTags } from "../parser.ts";
import {
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

const matchForNode = (
  node: DispositionTrieNode,
  documentPath: string,
  service?: string,
): ComposeRejectionMatch | undefined => {
  if (node.entry === undefined || node.matrixPath === undefined) return undefined;
  const entry = rejectedEntry(node.entry, node.matrixPath);
  if (entry === undefined) return undefined;
  const match = {
    matrixPath: node.matrixPath,
    documentPath,
    rationale: entry.rationale,
    remediation: entry.remediation,
  };
  return service === undefined ? match : { ...match, service };
};

interface WalkContext {
  readonly documentPath: string;
  readonly service?: string;
  readonly matches: ComposeRejectionMatch[];
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
    const match = matchForNode(child, documentPath, context.service);
    if (match !== undefined) {
      context.matches.push(match);
      continue;
    }
    walkValue(value[key], child, { ...context, documentPath });
  }
};

const walkServices = (value: unknown, matches: ComposeRejectionMatch[]): void => {
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

export const analyzeComposeRejections = (parsed: unknown): ReadonlyArray<ComposeRejectionMatch> => {
  if (!isRecord(parsed)) return [];
  const matches: ComposeRejectionMatch[] = [];
  for (const key of Object.keys(parsed)) {
    const matrixPath = key.startsWith("x-") ? "x-*" : key;
    const entry = composeTopLevelDispositions[matrixPath];
    if (entry === undefined) continue;
    const rejection = rejectedEntry(entry, matrixPath);
    if (rejection !== undefined) {
      matches.push({
        matrixPath,
        documentPath: key,
        rationale: rejection.rationale,
        remediation: rejection.remediation,
      });
      continue;
    }
    if (key === "services") walkServices(parsed[key], matches);
  }
  return matches;
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
