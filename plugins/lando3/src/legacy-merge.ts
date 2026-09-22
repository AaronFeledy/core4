/**
 * Pure Lando 3 foreign merging with authored provenance.
 * Source-tree anchor names restore identities lost during alias projection;
 * value equality alone would incorrectly discard independently authored objects.
 */
import { LEGACY_TAGGED, isLegacyTagged } from "@lando/sdk/landofile";
import type { LegacyDocument } from "@lando/sdk/landofile";
import type { ConfigTranslateSourceId } from "@lando/sdk/schema";

import { lando3SourceLayerOrder } from "./contract.ts";
import type {
  Lando3Path,
  Lando3Source,
  Lando3SourceLayer,
  LegacyItemIdentity,
  LegacyOccurrence,
  MergedLegacyItem,
  MergedLegacyValue,
} from "./contract.ts";
import { indexLegacySpans, lookupIdentityName, lookupSpan } from "./source.ts";

const nodeOccurrences = (value: MergedLegacyValue): ReadonlyArray<LegacyOccurrence> => {
  switch (value.kind) {
    case "scalar":
    case "tagged":
      return [...value.history, value.winner];
    case "mapping":
    case "sequence":
      return value.occurrences;
  }
};

const itemIdentity = (value: MergedLegacyValue): LegacyItemIdentity =>
  value.kind === "scalar" ? { kind: "primitive", value: value.value } : { kind: "unique", token: Symbol() };

const uniqueItems = (items: ReadonlyArray<MergedLegacyItem>): ReadonlyArray<MergedLegacyItem> => {
  const result: MergedLegacyItem[] = [];
  const indexes = new Map<unknown, number>();
  const anchors = new Map<string, symbol>();
  for (const item of items) {
    let key: unknown;
    switch (item.identity.kind) {
      case "primitive":
        key = item.identity.value;
        break;
      case "unique":
        key = item.identity.token;
        break;
      case "anchor": {
        const name = JSON.stringify([item.identity.sourceId, item.identity.name]);
        const token = anchors.get(name) ?? Symbol();
        anchors.set(name, token);
        key = token;
        break;
      }
    }
    // Map uses SameValueZero, including NaN and either sign of zero.
    const index = indexes.get(key);
    const retained = index === undefined ? undefined : result[index];
    if (index !== undefined && retained !== undefined) {
      result[index] = { ...retained, occurrences: [...retained.occurrences, ...item.occurrences] };
    } else {
      indexes.set(key, result.length);
      result.push(item);
    }
  }
  return result;
};

export const toMergedValue = (args: {
  readonly document: LegacyDocument;
  readonly sourceId: ConfigTranslateSourceId;
  readonly layer: Lando3SourceLayer;
}): MergedLegacyValue | undefined => {
  const index = indexLegacySpans(args.document.root);
  const visit = (value: unknown, keyPath: Lando3Path): MergedLegacyValue | undefined => {
    const occurrence: LegacyOccurrence = {
      sourceId: args.sourceId,
      layer: args.layer,
      keyPath,
      span: lookupSpan(index, keyPath),
    };
    if (isLegacyTagged(value)) {
      const inner = visit(value.value, keyPath);
      return inner === undefined
        ? undefined
        : {
            kind: "tagged",
            tag: value.tag,
            value: inner,
            winner: { ...occurrence, span: value.span },
            history: [],
          };
    }
    if (Array.isArray(value)) {
      const items: MergedLegacyItem[] = [];
      value.forEach((raw: unknown, offset: number) => {
        const path = [...keyPath, offset];
        const child = visit(raw, path);
        if (child === undefined) return;
        const name = lookupIdentityName(index, path);
        const identity: LegacyItemIdentity =
          child.kind !== "scalar" && name !== undefined
            ? { kind: "anchor", sourceId: args.sourceId, name }
            : itemIdentity(child);
        items.push({ value: child, identity, occurrences: nodeOccurrences(child) });
      });
      return { kind: "sequence", items: uniqueItems(items), occurrences: [occurrence] };
    }
    if (typeof value === "object" && value !== null) {
      const entries = new Map<string, MergedLegacyValue>();
      for (const [key, raw] of Object.entries(value)) {
        const child = visit(raw, [...keyPath, key]);
        if (child !== undefined) entries.set(key, child);
      }
      return { kind: "mapping", entries, occurrences: [occurrence] };
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return { kind: "scalar", value: value === 0 ? 0 : value, winner: occurrence, history: [] };
    }
    return undefined;
  };
  return visit(args.document.value, []);
};

const mergeValue = (
  old: MergedLegacyValue | undefined,
  fresh: MergedLegacyValue | undefined,
): MergedLegacyValue | undefined => {
  if (fresh === undefined) return old;
  if (old === undefined) return fresh;
  // The customizer runs on the destination array even when the source is not an array.
  if (old.kind === "sequence") {
    const incoming =
      fresh.kind === "sequence"
        ? fresh.items
        : [{ value: fresh, identity: itemIdentity(fresh), occurrences: nodeOccurrences(fresh) }];
    return {
      kind: "sequence",
      items: uniqueItems([...old.items, ...incoming]),
      occurrences: [...old.occurrences, ...nodeOccurrences(fresh)],
    };
  }
  if (old.kind === "mapping" && fresh.kind === "mapping") {
    const entries = new Map(old.entries);
    for (const [key, value] of fresh.entries) {
      const merged = mergeValue(entries.get(key), value);
      if (merged !== undefined) entries.set(key, merged);
    }
    return { kind: "mapping", entries, occurrences: [...old.occurrences, ...fresh.occurrences] };
  }
  switch (fresh.kind) {
    case "scalar":
    case "tagged":
      return { ...fresh, history: [...nodeOccurrences(old), ...fresh.history] };
    case "mapping":
    case "sequence":
      return { ...fresh, occurrences: [...nodeOccurrences(old), ...fresh.occurrences] };
  }
};

export const mergeLegacySources = (sources: ReadonlyArray<Lando3Source>): MergedLegacyValue | undefined =>
  [...sources]
    .sort((a, b) => lando3SourceLayerOrder(a.layer) - lando3SourceLayerOrder(b.layer))
    .reduce<MergedLegacyValue | undefined>((merged, source) => mergeValue(merged, source.value), undefined);

export const mergedToPlain = (value: MergedLegacyValue | undefined): unknown => {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case "scalar":
      return value.value;
    case "tagged":
      return {
        [LEGACY_TAGGED]: true,
        tag: value.tag,
        value: mergedToPlain(value.value),
        span: value.winner.span,
      };
    case "mapping":
      return Object.fromEntries([...value.entries].map(([key, child]) => [key, mergedToPlain(child)]));
    case "sequence":
      return value.items.map((item) => mergedToPlain(item.value));
  }
};

export const occurrencesAt = (
  value: MergedLegacyValue | undefined,
  path: Lando3Path,
): ReadonlyArray<LegacyOccurrence> => {
  if (value === undefined) return [];
  const [segment, ...rest] = path;
  if (segment === undefined) return nodeOccurrences(value);
  switch (value.kind) {
    case "mapping":
      return typeof segment === "string" ? occurrencesAt(value.entries.get(segment), rest) : [];
    case "sequence": {
      const item = typeof segment === "number" ? value.items[segment] : undefined;
      return rest.length === 0 ? (item?.occurrences ?? []) : occurrencesAt(item?.value, rest);
    }
    case "tagged":
      return occurrencesAt(value.value, path);
    case "scalar":
      return [];
  }
};
