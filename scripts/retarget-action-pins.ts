const REF_PATTERN = /^[A-Za-z0-9._-]$/;
const USES_LINE =
  /^(\s*)(?:-\s+)?uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([A-Za-z0-9._-]+)(?:\s+#\s+(v[0-9][A-Za-z0-9._-]*))?\s*$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export type ActionPinMove = {
  readonly action: string;
  readonly oldRef: string;
  readonly newRef: string;
  readonly oldComment: string | undefined;
  readonly newComment: string | undefined;
};

export type PinSource = {
  readonly path: string;
  readonly text: string;
};

export type PinDiff =
  | {
      readonly kind: "ok";
      readonly moves: readonly ActionPinMove[];
      readonly workflowPaths: readonly string[];
    }
  | { readonly kind: "rejected"; readonly reason: string };

export type PinApply =
  | { readonly kind: "applied"; readonly files: readonly PinSource[] }
  | { readonly kind: "unresolved"; readonly action: string; readonly oldRef: string };

type UsesPin = {
  readonly action: string;
  readonly ref: string;
  readonly comment: string | undefined;
};

const isRefChar = (char: string | undefined): boolean => char !== undefined && REF_PATTERN.test(char);

const countBounded = (text: string, token: string): number => {
  let count = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(token, cursor);
    if (found < 0) return count;
    const end = found + token.length;
    if (!isRefChar(found === 0 ? undefined : text[found - 1]) && !isRefChar(text[end])) count += 1;
    cursor = end;
  }
  return count;
};

const replaceBounded = (text: string, token: string, replacement: string, checkLeft: boolean): string => {
  let next = "";
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(token, cursor);
    if (found < 0) return next + text.slice(cursor);
    const end = found + token.length;
    const leftOk = !checkLeft || !isRefChar(found === 0 ? undefined : text[found - 1]);
    if (leftOk && !isRefChar(text[end])) next += text.slice(cursor, found) + replacement;
    else next += text.slice(cursor, end);
    cursor = end;
  }
  return next;
};

const parseUses = (line: string): UsesPin | undefined => {
  const match = USES_LINE.exec(line);
  const action = match?.[2];
  const ref = match?.[3];
  if (action === undefined || ref === undefined) return undefined;
  return { action, ref, comment: match?.[4] };
};

const reject = (reason: string): PinDiff => ({ kind: "rejected", reason });

export const parsePinDiff = (diff: string): PinDiff => {
  const moves = new Map<string, ActionPinMove>();
  const workflowPaths = new Set<string>();
  let currentPath: string | undefined;
  let pending: UsesPin | undefined;

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
      continue;
    if (line.startsWith("@@")) {
      if (pending !== undefined) return reject("pin removal was not replaced in place");
      continue;
    }
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      if (pending !== undefined) return reject("pin removal was not replaced in place");
      const before = header[1];
      const after = header[2];
      if (before === undefined || after === undefined || before !== after || !WORKFLOW_PATH.test(after)) {
        return reject(`diff touches ${after ?? line}, which is not an in-place workflow pin edit`);
      }
      currentPath = after;
      continue;
    }
    if (
      /^(?:new file mode|deleted file mode|similarity index|rename |old mode|new mode|Binary files|\\)/.test(
        line,
      )
    ) {
      return reject(`unsupported diff line: ${line}`);
    }
    if (currentPath === undefined) return reject(`diff line is outside a workflow hunk: ${line}`);
    const prefix = line[0];
    const body = line.slice(1);
    if (prefix === " ") {
      if (pending !== undefined) return reject("pin removal was not replaced in place");
      continue;
    }
    if (prefix !== "-" && prefix !== "+") return reject(`unsupported diff line: ${line}`);
    const pin = parseUses(body);
    if (pin === undefined) return reject(`non-pin workflow edit: ${body.trim()}`);
    if (prefix === "-") {
      if (pending !== undefined) return reject("removed two uses pins without a replacement");
      pending = pin;
      continue;
    }
    if (pending === undefined) return reject("added a uses pin without removing the previous one");
    if (pending.action !== pin.action) return reject(`replaced ${pending.action} with ${pin.action}`);
    if ((pending.comment === undefined) !== (pin.comment === undefined)) {
      return reject(`comment presence changed for ${pending.action}@${pending.ref}`);
    }
    const move: ActionPinMove = {
      action: pending.action,
      oldRef: pending.ref,
      newRef: pin.ref,
      oldComment: pending.comment,
      newComment: pin.comment,
    };
    const existing = moves.get(`${move.action}\n${move.oldRef}`);
    if (
      existing !== undefined &&
      (existing.newRef !== move.newRef ||
        existing.oldComment !== move.oldComment ||
        existing.newComment !== move.newComment)
    ) {
      return reject(`conflicting updates for ${move.action}@${move.oldRef}`);
    }
    moves.set(`${move.action}\n${move.oldRef}`, move);
    workflowPaths.add(currentPath);
    pending = undefined;
  }
  if (pending !== undefined) return reject("pin removal was not replaced in place");
  return { kind: "ok", moves: [...moves.values()], workflowPaths: [...workflowPaths] };
};

const holdersFor = (texts: readonly string[], pin: string): readonly string[] => {
  const names = new Set<string>();
  const escaped = pin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*["']${escaped}["']`,
    "g",
  );
  for (const text of texts) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
};

const rewriteComment = (text: string, move: ActionPinMove, texts: readonly string[]): string => {
  const oldComment = move.oldComment;
  const newComment = move.newComment;
  if (oldComment === undefined || newComment === undefined || oldComment === newComment) return text;
  const pin = `${move.action}@${move.newRef}`;
  const holders = holdersFor(texts, pin);
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("uses:")) return line;
      const named =
        countBounded(line, pin) > 0 ||
        holders.some((name) => new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(line));
      return named ? replaceBounded(line, ` # ${oldComment}`, ` # ${newComment}`, false) : line;
    })
    .join("\n");
};

export const applyPinMoves = (sources: readonly PinSource[], moves: readonly ActionPinMove[]): PinApply => {
  for (const move of moves) {
    const oldCount = sources.reduce(
      (sum, source) => sum + countBounded(source.text, `${move.action}@${move.oldRef}`),
      0,
    );
    if (oldCount > 0) continue;
    const newCount = sources.reduce(
      (sum, source) => sum + countBounded(source.text, `${move.action}@${move.newRef}`),
      0,
    );
    if (newCount === 0) return { kind: "unresolved", action: move.action, oldRef: move.oldRef };
  }

  let texts = sources.map((source) => source.text);
  for (const move of moves) {
    texts = texts.map((text) =>
      replaceBounded(text, `${move.action}@${move.oldRef}`, `${move.action}@${move.newRef}`, true),
    );
  }
  for (const move of moves) texts = texts.map((text) => rewriteComment(text, move, texts));

  return {
    kind: "applied",
    files: sources.flatMap((source, index) => {
      const text = texts[index];
      return text === undefined || text === source.text ? [] : [{ path: source.path, text }];
    }),
  };
};
