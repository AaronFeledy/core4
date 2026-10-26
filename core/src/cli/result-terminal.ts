import { Context } from "effect";

export const ResultTerminal = Context.Reference<{
  readonly isTTY: boolean;
  readonly columns: number | undefined;
}>("@lando/core/ResultTerminal", {
  defaultValue: () => ({ isTTY: false, columns: undefined }),
});
