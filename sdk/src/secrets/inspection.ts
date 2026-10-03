import { type Redactable, symbolRedactable } from "effect/Redactable";

// These objects retain secret values in closures, never in their inspection surface.
export const redactedInspection = {
  [symbolRedactable]: () => "[redacted]",
  [Symbol.for("nodejs.util.inspect.custom")]: () => "[redacted]",
  toJSON: () => "[redacted]",
  toString: () => "[redacted]",
} satisfies Redactable & {
  readonly toJSON: () => string;
  readonly toString: () => string;
  readonly [key: symbol]: () => string;
};
