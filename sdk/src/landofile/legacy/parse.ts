import { parseBlockScalar } from "./block-scalar.ts";
import type { LegacyMappingEntry, LegacyNode, LegacyTree } from "./contract.ts";
import { LegacyInlineParser } from "./flow.ts";
import { type ResolvedLegacyLimits, assertLegacyContentSize } from "./limits.ts";
import { LegacyScanner } from "./scanner.ts";

class LegacyBlockParser extends LegacyInlineParser {
  private sequenceIndicator(): boolean {
    return this.scan.char === "-" && /\s|^$/.test(this.scan.content[this.scan.offset + 1] ?? "");
  }

  block(depth: number): LegacyNode {
    const s = this.scan;
    s.depth(depth);
    s.structural();
    const indent = s.position().column - 1;
    if (this.sequenceIndicator()) return this.sequence(indent, depth);
    if (s.mappingColon() >= 0 && s.char !== "&" && s.char !== "!") return this.mapping(indent, depth);
    return this.value(indent - 1, depth, false);
  }

  private value(parentIndent: number, depth: number, compact: boolean): LegacyNode {
    const s = this.scan;
    s.spaces();
    const props = this.properties();
    const start = s.offset;
    let node: LegacyNode;
    if (s.done || s.atBreak || s.char === "#") {
      const empty = s.scalar("", "plain", start);
      s.finishLine();
      s.significant();
      node = !s.done && s.position().column - 1 > parentIndent ? this.block(depth) : empty;
    } else if (s.char === "|" || s.char === ">") {
      s.depth(depth);
      node = parseBlockScalar(s, parentIndent);
      s.significant();
    } else if (compact && (this.sequenceIndicator() || s.mappingColon() >= 0)) {
      node = this.block(depth);
    } else {
      node = this.read(depth);
      s.finishLine();
      s.significant();
    }
    return this.decorate(node, props);
  }

  private mapping(indent: number, depth: number): LegacyNode {
    const s = this.scan;
    const start = s.offset;
    const entries: LegacyMappingEntry[] = [];
    const keys = new Map<string, number>();
    while (!s.done && s.position().column - 1 >= indent) {
      s.structural();
      if (s.position().column - 1 !== indent)
        s.fail(
          "Malformed YAML indentation.",
          s.offset,
          "Align sibling mapping keys at the same indentation.",
        );
      const colon = s.mappingColon();
      if (colon < 0)
        s.fail(
          "Expected a YAML mapping entry.",
          s.offset,
          "Write a scalar key followed by ':' and its value.",
        );
      const key = this.scalar(false, true);
      s.spaces();
      if (s.offset !== colon || key.text === "") s.fail("Expected a scalar YAML mapping key.");
      s.uniqueKey(keys, key);
      s.offset += 1;
      const value = this.value(indent, depth + 1, false);
      entries.push({ key, value, span: { start: key.span.start, end: value.span.end } });
    }
    const end = entries.at(-1)?.value.span.end ?? s.position(start);
    return {
      kind: "mapping",
      entries,
      span: { start: s.position(start), end },
      tag: undefined,
      anchor: undefined,
    };
  }

  private sequence(indent: number, depth: number): LegacyNode {
    const s = this.scan;
    const start = s.offset;
    const items: LegacyNode[] = [];
    while (!s.done && s.position().column - 1 >= indent) {
      s.structural();
      if (s.position().column - 1 !== indent)
        s.fail(
          "Malformed YAML indentation.",
          s.offset,
          "Align sibling sequence indicators at the same indentation.",
        );
      if (!this.sequenceIndicator())
        s.fail("Expected a YAML sequence item.", s.offset, "Begin each item at this indentation with '- '.");
      s.offset += 1;
      items.push(this.value(indent, depth + 1, true));
    }
    const span = {
      start: items[0]?.span.start ?? s.position(start),
      end: items.at(-1)?.span.end ?? s.position(start),
    };
    return { kind: "sequence", items, span, tag: undefined, anchor: undefined };
  }
}

export const parseLegacyTree = (content: string, file: string, limits: ResolvedLegacyLimits): LegacyTree => {
  assertLegacyContentSize(content, file, limits.maxContentBytes);
  const scan = new LegacyScanner(content, file, limits);
  scan.significant();
  if (/^---(?:[ \t]+(?:#.*)?)?$/.test(content.slice(scan.offset, scan.lineEnd()))) {
    scan.nextLine();
    scan.significant();
  }
  const root = scan.done ? null : new LegacyBlockParser(scan).block(1);
  if (!scan.done) {
    scan.structural();
    scan.fail(
      "Malformed YAML indentation or an unexpected document value.",
      scan.offset,
      "Keep one root value and align sibling entries.",
    );
  }
  return { root, anchors: scan.anchors, aliasCount: scan.aliasCount };
};
