const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
} as const;

const wrap = (code: string, text: string): string => `${code}${text}${SGR.reset}`;

export const reset = (): string => SGR.reset;
export const bold = (text: string): string => wrap(SGR.bold, text);
export const dim = (text: string): string => wrap(SGR.dim, text);
export const cyan = (text: string): string => wrap(SGR.cyan, text);

export type ShouldStyleHelpInput = {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: ReadonlyArray<string>;
  readonly rendererMode: string | undefined;
};

const hasJsonOutputFlag = (argv: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") return false;
    if (arg === "--json" || arg === "-j" || arg === "--format=json") return true;
    if (arg === "--format" && argv[index + 1] === "json") return true;
  }
  return false;
};

export const shouldStyleHelp = (input: ShouldStyleHelpInput): boolean => {
  const noColor = input.env.NO_COLOR;
  return (
    input.isTTY &&
    (noColor === undefined || noColor === "") &&
    !hasJsonOutputFlag(input.argv) &&
    (input.rendererMode === undefined || input.rendererMode === "lando")
  );
};
