import type { ComposeDispositionEntry } from "./dispositions.ts";

export interface DispositionTrieNode {
  readonly exact: ReadonlyMap<string, DispositionTrieNode>;
  readonly extension?: DispositionTrieNode;
  readonly wildcard?: DispositionTrieNode;
  readonly matrixPath?: string;
  readonly entry?: ComposeDispositionEntry;
}

interface MutableDispositionTrieNode {
  readonly exact: Map<string, MutableDispositionTrieNode>;
  extension?: MutableDispositionTrieNode;
  wildcard?: MutableDispositionTrieNode;
  matrixPath?: string;
  entry?: ComposeDispositionEntry;
}

const makeNode = (): MutableDispositionTrieNode => ({ exact: new Map() });

const childForInsert = (node: MutableDispositionTrieNode, segment: string): MutableDispositionTrieNode => {
  if (segment === "x-*") {
    const child = node.extension ?? makeNode();
    node.extension = child;
    return child;
  }
  if (segment === "*") {
    const child = node.wildcard ?? makeNode();
    node.wildcard = child;
    return child;
  }
  const existing = node.exact.get(segment);
  if (existing !== undefined) return existing;
  const child = makeNode();
  node.exact.set(segment, child);
  return child;
};

export const compileDispositionTrie = (
  dispositions: Readonly<Record<string, ComposeDispositionEntry>>,
): DispositionTrieNode => {
  const root = makeNode();
  for (const [matrixPath, entry] of Object.entries(dispositions)) {
    let node = root;
    for (const segment of matrixPath.split(".")) node = childForInsert(node, segment);
    node.matrixPath = matrixPath;
    node.entry = entry;
  }
  return root;
};

export const matchDispositionChild = (
  node: DispositionTrieNode,
  segment: string,
): DispositionTrieNode | undefined => {
  const exact = node.exact.get(segment);
  if (exact !== undefined) return exact;
  if (segment.startsWith("x-") && node.extension !== undefined) return node.extension;
  return node.wildcard;
};

export const matchDispositionPath = (
  root: DispositionTrieNode,
  segments: ReadonlyArray<string>,
): DispositionTrieNode | undefined => {
  let node: DispositionTrieNode | undefined = root;
  for (const segment of segments) {
    if (node === undefined) return undefined;
    node = matchDispositionChild(node, segment);
  }
  return node;
};
