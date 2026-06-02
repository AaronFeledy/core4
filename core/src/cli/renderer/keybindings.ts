export type KeyToken = "up" | "down" | "enter" | "esc" | "tab" | "unknown";

const ESC = String.fromCharCode(27);

export const parseKey = (raw: string): KeyToken => {
  switch (raw) {
    case `${ESC}[A`:
      return "up";
    case `${ESC}[B`:
      return "down";
    case "\r":
    case "\n":
      return "enter";
    case ESC:
      return "esc";
    case "\t":
      return "tab";
    default:
      return "unknown";
  }
};

export type KeyAction = "focus.up" | "focus.down" | "tree.cycle" | "detail.expand" | "detail.collapse";

export const DEFAULT_KEYMAP: Readonly<Record<KeyToken, KeyAction | null>> = {
  up: "focus.up",
  down: "focus.down",
  tab: "tree.cycle",
  enter: "detail.expand",
  esc: "detail.collapse",
  unknown: null,
};
