import { Predicate, Schema } from "effect";
import { ConfigExpressionError } from "../errors/config.ts";
import {
  BoundText,
  type BoundTextReference,
  EnvironmentValue,
  SecretRef,
  encodeUriComponent,
  normalizeEnvironmentValue,
} from "../schema/environment-value.ts";

export const isEnvironmentBinding = (value: unknown): value is SecretRef | BoundText =>
  Schema.is(SecretRef)(value) || Schema.is(BoundText)(value);

export const containsReservedBinding = (value: unknown): boolean => {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!Predicate.isObjectOrArray(item) || seen.has(item)) continue;
    seen.add(item);
    if (!Array.isArray(item) && (item._tag === "SecretRef" || item._tag === "BoundText")) return true;
    pending.push(...Object.values(item));
  }
  return false;
};

export const concatenateEnvironmentValues = (values: readonly EnvironmentValue[]): EnvironmentValue => {
  const parts: Array<string | BoundTextReference> = [];
  for (const value of values) {
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    switch (value._tag) {
      case "SecretRef":
        parts.push({ reference: value.reference, encoding: "raw" });
        break;
      case "BoundText":
        parts.push(...value.parts);
        break;
      default:
        assertNever(value);
    }
  }
  return Schema.decodeUnknownSync(EnvironmentValue)(normalizeEnvironmentValue({ _tag: "BoundText", parts }));
};

export const encodeEnvironmentComponent = (value: EnvironmentValue): EnvironmentValue => {
  if (typeof value === "string") return encodeUriComponent(value);
  switch (value._tag) {
    case "SecretRef":
      return { _tag: "BoundText", parts: [{ reference: value.reference, encoding: "uri-component" }] };
    case "BoundText":
      return concatenateEnvironmentValues(
        value.parts.map((part) => {
          if (typeof part === "string") return encodeUriComponent(part);
          if (part.encoding === "uri-component")
            throw bindingExpressionError("Repeated binding encoding is unsupported.", {});
          return { _tag: "BoundText", parts: [{ ...part, encoding: "uri-component" }] };
        }),
      );
    default:
      return assertNever(value);
  }
};

export const bindingExpressionError = (
  message: string,
  site: {
    readonly path?: ConfigExpressionError["path"] | undefined;
    readonly filePath?: string | undefined;
    readonly expression?: string | undefined;
  },
): ConfigExpressionError =>
  new ConfigExpressionError({
    message,
    path: site.path ?? [],
    filePath: site.filePath ?? "",
    expression: site.expression ?? "",
    remediation:
      "Copy bindings directly, concatenate text, or use url.encodeComponent(); other helpers require literal values.",
  });
const assertNever = (value: never): never => value;
