import { YAML_REFERENCE_NAME_PATTERN } from "../yaml-references.ts";
import type { LegacyMappingEntry, LegacyNode, LegacyScalarNode } from "./contract.ts";
import { parseQuotedScalar } from "./quoted-scalar.ts";
import type { LegacyScanner } from "./scanner.ts";

const REFERENCE = new RegExp(`^(?:${YAML_REFERENCE_NAME_PATTERN.source})`);
interface NodeProperties {
  readonly anchor: string | undefined;
  readonly tag: string | undefined;
  readonly start: number;
}

export class LegacyInlineParser {
  constructor(readonly scan: LegacyScanner) {}

  properties(): NodeProperties {
    const s = this.scan;
    const start = s.offset;
    let anchor: string | undefined;
    let tag: string | undefined;
    while (s.char === "&" || s.char === "!") {
      const at = s.offset;
      if (s.char === "&") {
        if (anchor !== undefined) s.fail("A YAML node cannot have two anchors.");
        s.offset += 1;
        anchor = this.reference();
        if (s.definedAnchors.has(anchor))
          s.fail(`Duplicate YAML anchor &${anchor}.`, at, "Define each anchor once before use.");
        s.definedAnchors.add(anchor);
      } else {
        if (tag !== undefined) s.fail("A YAML node cannot have two tags.");
        if (s.content.startsWith("!<", at)) {
          const end = s.content.indexOf(">", at + 2);
          if (end < 0 || end > s.lineEnd()) s.fail("Unterminated verbatim YAML tag.");
          s.offset = end + 1;
        } else {
          s.offset += 1;
          while (!s.done && !/[\s,[\]{}]/.test(s.char)) s.offset += 1;
        }
        tag = s.content.slice(at, s.offset);
      }
      if (!s.done && !/\s/.test(s.char)) s.fail("Expected whitespace after YAML node properties.");
      s.spaces();
    }
    return { anchor, tag, start };
  }

  decorate(node: LegacyNode, props: NodeProperties): LegacyNode {
    switch (node.kind) {
      case "alias":
        if (props.anchor !== undefined || props.tag !== undefined)
          this.scan.fail(
            "An alias cannot carry YAML node properties.",
            props.start,
            "Put the tag or anchor on the referenced node instead.",
          );
        return node;
      case "scalar":
      case "mapping":
      case "sequence": {
        const result = { ...node, anchor: props.anchor, tag: props.tag };
        if (props.anchor !== undefined) this.scan.anchors.set(props.anchor, result);
        return result;
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  }

  reference(): string {
    const s = this.scan;
    const name =
      REFERENCE.exec(s.content.slice(s.offset))?.[0] ??
      s.fail(
        "Invalid YAML reference name.",
        s.offset,
        "Use a non-empty name without whitespace or flow punctuation.",
      );
    s.offset += name.length;
    return name;
  }

  read(depth: number, flow = false): LegacyNode {
    const s = this.scan;
    s.depth(depth);
    s.structural();
    const props = this.properties();
    if (flow) s.flowSpace();
    const start = s.offset;
    let node: LegacyNode;
    if (s.char === "*") {
      s.offset += 1;
      const name = this.reference();
      if (!s.definedAnchors.has(name))
        s.fail(
          `Unknown YAML alias *${name}.`,
          start,
          "Define the anchor earlier in this document before using its alias.",
        );
      s.aliasCount += 1;
      node = { kind: "alias", name, span: s.span(start) };
    } else if (s.char === "[" || s.char === "{") node = this.collection(depth);
    else node = this.scalar(flow);
    return this.decorate(node, props);
  }

  scalar(flow: boolean, key = false): LegacyScalarNode {
    const s = this.scan;
    if (s.char === "'" || s.char === '"') return parseQuotedScalar(s);
    const start = s.offset;
    let text = "";
    let end = start;
    while (!s.done) {
      if (s.atBreak) {
        if (!flow || key) break;
        const line = s.position().line;
        s.nextLine();
        s.significant();
        s.structural();
        if (s.done || /[,\[\]{}]/.test(s.char)) break;
        const breaks = s.position().line - line;
        text = text.trimEnd() + (breaks === 1 ? " " : "\n".repeat(breaks - 1));
      }
      const char = s.char;
      if (flow && /[,\[\]{}]/.test(char)) break;
      if (char === "#" && (s.offset === start || /\s/.test(s.content[s.offset - 1] ?? ""))) break;
      if (
        char === ":" &&
        (/\s|^$/.test(s.content[s.offset + 1] ?? "") ||
          (flow && /[,\]}]/.test(s.content[s.offset + 1] ?? "")))
      ) {
        if (!key)
          s.fail(
            flow
              ? "Single-pair flow entries are not supported."
              : "Unexpected mapping separator in a scalar.",
            s.offset,
            "Use an explicit {key: value} mapping or quote the scalar.",
          );
        break;
      }
      text += char;
      s.offset += 1;
      if (!/\s/.test(char)) end = s.offset;
    }
    const trimmed = text.trimEnd();
    return { ...s.scalar(trimmed, "plain", start), span: s.span(start, end) };
  }

  private collection(depth: number): LegacyNode {
    const s = this.scan;
    const start = s.offset;
    const mapping = s.content[start] === "{";
    const close = mapping ? "}" : "]";
    const entries: LegacyMappingEntry[] = [];
    const items: LegacyNode[] = [];
    const keys = new Map<string, number>();
    s.offset += 1;
    s.flowSpace();
    while (s.char !== close) {
      if (s.done || /[\]}]/.test(s.char)) s.fail("Malformed flow collection: expected a closing delimiter.");
      s.structural();
      if (mapping) {
        const key = this.scalar(true, true);
        if (key.text === "" && key.style === "plain") s.fail("Expected a scalar flow mapping key.");
        s.flowSpace();
        if (s.char !== ":") s.fail("Expected ':' after flow mapping key.");
        s.uniqueKey(keys, key);
        s.offset += 1;
        s.flowSpace();
        const value = this.read(depth + 1, true);
        entries.push({ key, value, span: { start: key.span.start, end: value.span.end } });
      } else {
        const value = this.read(depth + 1, true);
        if (
          value.kind === "scalar" &&
          value.text === "" &&
          value.style === "plain" &&
          value.tag === undefined &&
          value.anchor === undefined
        )
          s.fail("Missing flow sequence entry.");
        items.push(value);
      }
      s.flowSpace();
      if (!mapping && s.char === ":")
        s.fail(
          "Single-pair flow entries are not supported.",
          s.offset,
          "Wrap the pair in an explicit {key: value} mapping.",
        );
      if (s.char === close) break;
      if (s.char !== ",") s.fail("Malformed flow collection: expected ',' or a closing delimiter.");
      s.offset += 1;
      s.flowSpace();
    }
    s.offset += 1;
    const first = mapping ? entries[0]?.key : items[0];
    const last = mapping ? entries.at(-1)?.value : items.at(-1);
    const span = first && last ? { start: first.span.start, end: last.span.end } : s.span(start);
    return mapping
      ? { kind: "mapping", entries, span, tag: undefined, anchor: undefined }
      : { kind: "sequence", items, span, tag: undefined, anchor: undefined };
  }
}
