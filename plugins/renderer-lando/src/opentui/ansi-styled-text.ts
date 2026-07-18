type NativeTextChunkLike = {
  readonly __isChunk: true;
  readonly text: string;
};

type NativeStyledTextLike = {
  readonly chunks: ReadonlyArray<NativeTextChunkLike>;
};

type NativeStyleInput = string | NativeTextChunkLike;
type NativeStyleFunction = (input: NativeStyleInput) => NativeTextChunkLike;

export interface NativeStyledTextModuleLike {
  readonly StyledText: new (chunks: NativeTextChunkLike[]) => NativeStyledTextLike;
  readonly stringToStyledText: (content: string) => NativeStyledTextLike;
  readonly bold: NativeStyleFunction;
  readonly dim: NativeStyleFunction;
  readonly red: NativeStyleFunction;
  readonly green: NativeStyleFunction;
  readonly yellow: NativeStyleFunction;
  readonly cyan: NativeStyleFunction;
  readonly brightMagenta: NativeStyleFunction;
}

const REQUIRED_EXPORTS = [
  "StyledText",
  "stringToStyledText",
  "bold",
  "dim",
  "red",
  "green",
  "yellow",
  "cyan",
  "brightMagenta",
] as const;

export const hasNativeStyledText = (value: object): value is NativeStyledTextModuleLike =>
  REQUIRED_EXPORTS.every((name) => name in value && typeof Reflect.get(value, name) === "function");

type Foreground = "red" | "green" | "yellow" | "cyan" | "brightMagenta";

type StyleState = {
  foreground: Foreground | undefined;
  bold: boolean;
  dim: boolean;
};

const ESC = String.fromCharCode(27);
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const CONTROL_STRING_STARTS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const ESC_CONTROL_STRING_STARTS = new Set(["]", "P", "X", "^", "_"]);

type CsiSequence = {
  readonly final: string | undefined;
  readonly nextOffset: number;
  readonly parameters: string;
};

const readCsi = (content: string, offset: number): CsiSequence => {
  for (let index = offset; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        final: content[index],
        nextOffset: index + 1,
        parameters: content.slice(offset, index),
      };
    }
  }
  return { final: undefined, nextOffset: content.length, parameters: "" };
};

const skipControlString = (content: string, offset: number): number => {
  for (let index = offset; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === BEL || code === C1_ST) return index + 1;
    if (content[index] === ESC && content[index + 1] === "\\") return index + 2;
  }
  return content.length;
};

const applyCode = (state: StyleState, code: number): void => {
  switch (code) {
    case 0:
      state.foreground = undefined;
      state.bold = false;
      state.dim = false;
      return;
    case 1:
      state.bold = true;
      return;
    case 2:
      state.dim = true;
      return;
    case 22:
      state.bold = false;
      state.dim = false;
      return;
    case 31:
      state.foreground = "red";
      return;
    case 32:
      state.foreground = "green";
      return;
    case 33:
      state.foreground = "yellow";
      return;
    case 36:
      state.foreground = "cyan";
      return;
    case 39:
      state.foreground = undefined;
      return;
    case 95:
      state.foreground = "brightMagenta";
      return;
    default:
      return;
  }
};

const styleChunk = (
  module: NativeStyledTextModuleLike,
  state: Readonly<StyleState>,
  text: string,
): ReadonlyArray<NativeTextChunkLike> => {
  if (text.length === 0) return [];
  if (state.foreground === undefined && !state.bold && !state.dim) {
    return module.stringToStyledText(text).chunks;
  }
  if (state.foreground !== undefined) {
    let chunk = module[state.foreground](text);
    if (state.bold) chunk = module.bold(chunk);
    if (state.dim) chunk = module.dim(chunk);
    return [chunk];
  }
  if (state.bold) {
    const chunk = module.bold(text);
    return [state.dim ? module.dim(chunk) : chunk];
  }
  return [module.dim(text)];
};

export const ansiToNativeStyledText = (
  module: NativeStyledTextModuleLike,
  content: string,
): NativeStyledTextLike => {
  const chunks: NativeTextChunkLike[] = [];
  const state: StyleState = { foreground: undefined, bold: false, dim: false };
  let plainText = "";
  let offset = 0;

  const flush = (): void => {
    chunks.push(...styleChunk(module, state, plainText));
    plainText = "";
  };

  const consumeCsi = (sequenceOffset: number): number => {
    const sequence = readCsi(content, sequenceOffset);
    if (sequence.final === "m" && /^[0-9;]*$/.test(sequence.parameters)) {
      const codes = sequence.parameters === "" ? [0] : sequence.parameters.split(";").map(Number);
      for (const code of codes) applyCode(state, code);
    }
    return sequence.nextOffset;
  };

  while (offset < content.length) {
    const code = content.charCodeAt(offset);
    if (content[offset] === ESC) {
      flush();
      const next = content[offset + 1];
      if (next === "[") {
        offset = consumeCsi(offset + 2);
      } else if (next !== undefined && ESC_CONTROL_STRING_STARTS.has(next)) {
        offset = skipControlString(content, offset + 2);
      } else {
        offset = Math.min(content.length, offset + 2);
      }
      continue;
    }
    if (code === C1_CSI) {
      flush();
      offset = consumeCsi(offset + 1);
      continue;
    }
    if (CONTROL_STRING_STARTS.has(code)) {
      flush();
      offset = skipControlString(content, offset + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      flush();
      offset += 1;
      continue;
    }
    plainText += content[offset];
    offset += 1;
  }
  flush();
  return new module.StyledText(chunks);
};
