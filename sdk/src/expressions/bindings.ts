import { Predicate, Schema } from "effect";
import { ConfigExpressionError } from "../errors/config.ts";
import {
  BoundText,
  type BoundTextReference,
  EnvironmentValue,
  RouteText,
  type RouteUrlPart,
  SecretRef,
  encodeUriComponent,
  normalizeEnvironmentValue,
} from "../schema/environment-value.ts";

export const isEnvironmentBinding = (value: unknown): value is SecretRef | BoundText | RouteText =>
  Schema.is(SecretRef)(value) || Schema.is(BoundText)(value) || Schema.is(RouteText)(value);

export const containsReservedBinding = (value: unknown): boolean => {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!Predicate.isObjectOrArray(item) || seen.has(item)) continue;
    seen.add(item);
    if (
      !Array.isArray(item) &&
      (item._tag === "SecretRef" || item._tag === "BoundText" || item._tag === "RouteText")
    )
      return true;
    pending.push(...Object.values(item));
  }
  return false;
};

export const concatenateEnvironmentValues = (values: readonly EnvironmentValue[]): EnvironmentValue => {
  const secretParts: (string | BoundTextReference)[] = [];
  const routeParts: (string | RouteUrlPart)[] = [];
  let hasSecret = false;
  let hasRoute = false;
  for (const value of values) {
    if (typeof value === "string") {
      secretParts.push(value);
      routeParts.push(value);
      continue;
    }
    switch (value._tag) {
      case "SecretRef":
        hasSecret = true;
        secretParts.push({ reference: value.reference, encoding: "raw" });
        break;
      case "BoundText":
        hasSecret = true;
        secretParts.push(...value.parts);
        break;
      case "RouteText":
        hasRoute = true;
        routeParts.push(...value.parts);
        break;
      default:
        assertNever(value);
    }
  }
  if (hasRoute && hasSecret)
    throw new ConfigExpressionError({
      path: [],
      filePath: "",
      expression: "",
      message: "A public URL and a secret cannot share one environment value; split them into two variables.",
      remediation: "Split the public URL and secret into two environment variables.",
    });
  return Schema.decodeUnknownSync(EnvironmentValue)(
    hasRoute ? { _tag: "RouteText", parts: routeParts } : { _tag: "BoundText", parts: secretParts },
  );
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
    case "RouteText":
      return normalizeEnvironmentValue({
        _tag: "RouteText",
        parts: value.parts.map((part) => {
          if (typeof part === "string") return encodeUriComponent(part);
          if (part.encoding === "uri-component")
            throw bindingExpressionError("Repeated binding encoding is unsupported.", {});
          return { ...part, encoding: "uri-component" };
        }),
      });
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
