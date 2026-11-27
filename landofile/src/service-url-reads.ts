import type { ExpressionNode, ExpressionTemplate, PathSegment } from "@lando/sdk/expressions";
import { PUBLIC_ROUTE_FACTS, type PublicRouteFact } from "@lando/sdk/schema";

/**
 * Why a `services` read at an invocation site cannot be classified as a literal route-fact read or
 * a literal read of another published fact.
 */
export type ServiceUrlReadRefusal = "computed-service" | "computed-member" | "whole-service";

type RefusedRead =
  | { readonly refusal: "computed-service"; readonly fact: PublicRouteFact }
  | { readonly refusal: Exclude<ServiceUrlReadRefusal, "computed-service"> };

export type ServiceUrlReads = {
  /**
   * Services whose public route facts (`url`, `hostname`, `origin`, `publicPort`, `scheme`) the
   * expression reads through literal dot or bracket access, each with the facts read, in first-read order.
   */
  readonly services: ReadonlyMap<string, ReadonlySet<PublicRouteFact>>;
} & (RefusedRead | { readonly refusal?: never });

/** A literal `services.<name>.<fact>` read, normalized from dot, bracket, and parenthesized forms. */
export interface ServiceUrlReadPath {
  readonly service: string;
  readonly fact: PublicRouteFact;
  /** Segments after the fact, such as an index into its text. */
  readonly rest: readonly PathSegment[];
}

const ROUTE_FACTS: ReadonlySet<string> = new Set(PUBLIC_ROUTE_FACTS);

/** True when a `services.<name>` member is a public route fact rather than another published fact. */
export const isPublicRouteFact = (member: string | undefined): member is PublicRouteFact =>
  member !== undefined && ROUTE_FACTS.has(member);

export const staticServicePathName = (segment: PathSegment | undefined): string | undefined => {
  switch (segment?.type) {
    case undefined:
      return undefined;
    case "prop":
      return segment.name;
    case "key":
      return segment.key;
    case "index":
      return String(segment.index);
    case "dynamic":
      return segment.expr.kind === "Literal" && typeof segment.expr.value === "string"
        ? segment.expr.value
        : undefined;
    default:
      return segment satisfies never;
  }
};

/** `(services.web).url` and `(services).web.url` read the same path as `services.web.url`. */
export const flattenedServicesPath = (node: ExpressionNode): readonly PathSegment[] | undefined => {
  switch (node.kind) {
    case "Path":
      return node.head === "services" ? node.segments : undefined;
    case "Access": {
      const target = flattenedServicesPath(node.target);
      return target === undefined ? undefined : [...target, ...node.segments];
    }
    default:
      return undefined;
  }
};

type Classified =
  | {
      readonly kind: "route";
      readonly service: string;
      readonly fact: PublicRouteFact;
      readonly rest: readonly PathSegment[];
    }
  | { readonly kind: "other" }
  | ({ readonly kind: "refused" } & RefusedRead);

/** A literal non-URL member (`services[name].port`) is another fact's concern, never a URL read. */
const classifySegments = (segments: readonly PathSegment[]): Classified => {
  const [first, second, ...rest] = segments;
  if (first === undefined || second === undefined) return { kind: "refused", refusal: "whole-service" };
  const member = staticServicePathName(second);
  if (member === undefined) return { kind: "refused", refusal: "computed-member" };
  if (!isPublicRouteFact(member)) return { kind: "other" };
  const service = staticServicePathName(first);
  return service === undefined
    ? { kind: "refused", refusal: "computed-service", fact: member }
    : { kind: "route", service, fact: member, rest };
};

/** The literal route-fact read this node performs itself, ignoring reads nested in its own segments. */
export const serviceUrlReadPath = (node: ExpressionNode): ServiceUrlReadPath | undefined => {
  const segments = flattenedServicesPath(node);
  if (segments === undefined) return undefined;
  const classified = classifySegments(segments);
  return classified.kind === "route"
    ? { service: classified.service, fact: classified.fact, rest: classified.rest }
    : undefined;
};

/**
 * Every `services.<name>.<url|hostname|origin|publicPort|scheme>` read, and whether any `services`
 * read is unclassifiable.
 */
export const serviceUrlReads = (ast: ExpressionTemplate | ExpressionNode): ServiceUrlReads => {
  const services = new Map<string, Set<PublicRouteFact>>();
  let refused: RefusedRead | undefined;
  const visitSegments = (segments: readonly PathSegment[]): void => {
    for (const segment of segments) if (segment.type === "dynamic") visit(segment.expr);
  };
  const visit = (node: ExpressionNode): void => {
    switch (node.kind) {
      case "Literal":
        return;
      case "Path":
      case "Access": {
        const segments = flattenedServicesPath(node);
        if (segments === undefined) {
          if (node.kind === "Access") visit(node.target);
          visitSegments(node.segments);
          return;
        }
        const classified = classifySegments(segments);
        if (classified.kind === "route")
          services.set(
            classified.service,
            new Set([...(services.get(classified.service) ?? []), classified.fact]),
          );
        // A computed-name route-fact read outranks other refusals: sites that admit no URL refuse only it.
        else if (
          classified.kind === "refused" &&
          (refused === undefined || classified.refusal === "computed-service")
        ) {
          const { kind: _, ...read } = classified;
          refused = read;
        }
        visitSegments(segments);
        return;
      }
      case "ArrayLiteral":
        for (const element of node.elements) visit(element);
        return;
      case "ObjectLiteral":
        for (const entry of node.entries) visit(entry.value);
        return;
      case "Conditional":
        visit(node.test);
        visit(node.consequent);
        visit(node.alternate);
        return;
      case "Call":
        for (const argument of node.args) visit(argument);
        return;
      default:
        node satisfies never;
    }
  };
  if ("whole" in ast) {
    for (const segment of ast.segments)
      if (segment.kind === "InterpolationSegment") visit(segment.expression);
  } else visit(ast);
  return { services, ...refused };
};

/** True when the expression reads at least one public service route fact. */
export const readsServiceUrl = (ast: ExpressionTemplate | ExpressionNode): boolean =>
  serviceUrlReads(ast).services.size > 0;

/**
 * Whether a value path may read a public route fact (`url`, `hostname`, `origin`, `publicPort`, or
 * `scheme`) at invocation: tooling commands, `cmds` steps, env values, and vars (literal, `sh`, and
 * var `env`), `toolingDefaults` env and literal vars, and Landofile event step `cmd`, `defer`,
 * `env`, and `if`. A v1 `hostEvents` step has only a command, so only its string form or `cmd` may.
 * Placement fields, selectors, Lando command inputs, task ids, and include fields never may.
 */
export const isServiceUrlInvocationPath = (path: readonly (string | number)[]): boolean => {
  const [root, name, field, index, leaf, extra] = path;
  if (root === "tooling" && typeof name === "string") {
    switch (field) {
      case undefined:
        return true;
      case "cmd":
        return index === undefined || (typeof index === "number" && leaf === undefined);
      case "cmds":
        return (
          typeof index === "number" &&
          (leaf === undefined ||
            (leaf === "cmd" && extra === undefined) ||
            (leaf === "env" && typeof extra === "string" && path.length === 6))
        );
      case "env":
        return typeof index === "string" && leaf === undefined;
      case "vars":
        return (
          typeof index === "string" &&
          (leaf === undefined ||
            (leaf === "sh" && extra === undefined) ||
            (leaf === "env" && typeof extra === "string" && path.length === 6))
        );
      default:
        return false;
    }
  }
  if (root === "toolingDefaults")
    return (name === "env" || name === "vars") && typeof field === "string" && path.length === 3;
  if (root === "hostEvents" && typeof name === "string" && typeof field === "number")
    return index === undefined || (index === "cmd" && leaf === undefined);
  if (root === "events" && typeof name === "string" && typeof field === "number") {
    if (index === undefined) return true;
    if (index === "cmd" || index === "defer" || index === "if") return leaf === undefined;
    return index === "env" && typeof leaf === "string" && path.length === 5;
  }
  return false;
};
