import { type JsonSchema, Predicate } from "effect";
import {
  composeServiceDispositions,
  composeTopLevelDispositions,
} from "../landofile/compose-dispositions.ts";
import { wholeTemplatePattern } from "./landofile-authoring-expression.ts";

type Name = "LandofileShape" | "GlobalConfig";
type Node = JsonSchema.JsonSchema;
type Editors = Readonly<Record<Name, Node>>;
type Rule = "casing" | "tag" | "discriminator" | "time-unit" | "shared-type" | "twin" | "condition";
type Finding = `${Name}.${string} ${Rule}`;

const nodes = (items: unknown): Node[] => (Array.isArray(items) ? items.filter(Predicate.isObject) : []);
const properties = (node: Node): Node => (Predicate.isObject(node.properties) ? node.properties : {});
const alternatives = (node: Node): Node[] => [...nodes(node.anyOf), ...nodes(node.oneOf)];
const impossible = (node: Node): boolean =>
  node.not === true || (Predicate.isObject(node.not) && Object.keys(node.not).length === 0);
const literals = (node: Node): readonly unknown[] =>
  Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];

const composeKey = (name: Name, path: readonly string[]): boolean => {
  if (path[0] === "serviceDefaults" && path.length > 1) return true;
  if (name !== "LandofileShape") return false;
  const service = path[0] === "services" && path[1] === "*";
  const parts = (service ? path.slice(2) : path).filter((part) => part !== "[]");
  // Readiness shares the healthcheck input codec, including its Compose fields.
  if (service && parts[0] === "readiness") parts[0] = "healthcheck";
  return Object.hasOwn(service ? composeServiceDispositions : composeTopLevelDispositions, parts.join("."));
};

const conditionAllowed = (name: Name, path: string, description: string): boolean => {
  if (path.endsWith(".if"))
    return (
      /^(?:events|hostEvents)\.\*\.\[\]\.if$/u.test(path) &&
      /invocation time|when the step runs/iu.test(description)
    );
  if (name !== "LandofileShape") return false;
  if (path === "recipe.variants.[].when")
    return /options.only/iu.test(description) && /compile time|recipe compiler/iu.test(description);
  return (
    /^(?:(?:includes|include)\.\[\]|toolingIncludes\.\*)\.when$/u.test(path) &&
    /load time/iu.test(description) &&
    /\brecipe\b/u.test(description) &&
    /\benv\b/u.test(description)
  );
};

const schemaTypes = (node: Node): readonly string[] => {
  if (node.pattern === wholeTemplatePattern.source) return [];
  const types = Array.isArray(node.type)
    ? node.type.filter(Predicate.isString)
    : typeof node.type === "string"
      ? [node.type]
      : [];
  const dictionary =
    Object.keys(properties(node)).length === 0 &&
    (Predicate.isObject(node.additionalProperties) || Predicate.isObject(node.patternProperties));
  return [
    ...types.map((type) => (type === "object" && dictionary ? "record" : type)),
    ...literals(node).map((value) => (value === null ? "null" : typeof value)),
  ];
};

const resolveLocal = (root: Node, ref: unknown): Node | undefined => {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const token of decodeURIComponent(ref.slice(2)).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Predicate.isObjectOrArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  return Predicate.isObject(value) ? value : undefined;
};

const inspectEditor = (name: Name, root: Node, findings: Set<Finding>): ReadonlyMap<string, Set<string>> => {
  const types = new Map<string, Set<string>>();
  const active = new Set<Node>();
  const linked = (node: Node): Node[] => {
    const ref = resolveLocal(root, node.$ref);
    return [...alternatives(node), ...nodes(node.allOf), ...(ref === undefined ? [] : [ref])];
  };
  const expand = (node: Node, seen = new Set<Node>()): Node[] => {
    if (seen.has(node) || impossible(node)) return [];
    seen.add(node);
    return [node, ...linked(node).flatMap((child) => expand(child, seen))];
  };
  const add = (path: readonly string[], rule: Rule) => findings.add(`${name}.${path.join(".")} ${rule}`);
  const inspectDiscriminators = (node: Node, path: readonly string[]): void => {
    const arms = alternatives(node)
      .flatMap((child) => expand(child))
      .filter((child) => Object.keys(properties(child)).length > 0);
    const first = arms[0];
    if (first === undefined || arms.length < 2) return;
    for (const key of Object.keys(properties(first))) {
      if (key === "kind" || key === "_tag" || composeKey(name, [...path, key])) continue;
      const tags = arms.map((arm) => {
        const field = properties(arm)[key];
        if (!Array.isArray(arm.required) || !arm.required.includes(key) || !Predicate.isObject(field))
          return [];
        return [...new Set(expand(field).flatMap(literals))];
      });
      // A payload enum is not a constant discriminator, even when the authoring projection splits the enum.
      if (tags.every((values) => values.length === 1) && new Set(tags.flat()).size > 1)
        add([...path, key], "discriminator");
    }
  };
  const visit = (node: Node, path: readonly string[]): void => {
    if (active.has(node) || impossible(node)) return;
    active.add(node);
    inspectDiscriminators(node, path);
    const twins = new Map<string, string>();
    for (const [key, field] of Object.entries(properties(node))) {
      if (!Predicate.isObject(field) || impossible(field)) continue;
      const fieldPath = [...path, key];
      const joined = fieldPath.join(".");
      const compose = composeKey(name, fieldPath);
      const eventName = path.length === 1 && (path[0] === "events" || path[0] === "hostEvents");
      const folded = key.replaceAll(/[-_]/gu, "").toLowerCase();
      const twin = twins.get(folded);
      if (twin !== undefined) add([...path, [key, twin].sort().join("|")], "twin");
      twins.set(folded, key);
      if (key === "_tag") add(fieldPath, "tag");
      else if (!compose && !eventName && !key.startsWith("x-") && !/^[a-z][a-zA-Z0-9]*$/u.test(key))
        add(fieldPath, "casing");
      const branches = expand(field);
      const literalTypes = types.get(joined) ?? new Set<string>();
      for (const type of branches.flatMap(schemaTypes)) literalTypes.add(type);
      types.set(joined, literalTypes);
      if (
        !compose &&
        /^(?:timeout|interval|period|delay|threshold|ttl|grace)$|(?:Timeout|Interval|Period|Delay|Threshold|Ttl|TTL|Grace)$/u.test(
          key,
        ) &&
        (literalTypes.has("number") || literalTypes.has("integer"))
      )
        add(fieldPath, "time-unit");
      if (
        !compose &&
        ["if", "when", "condition", "unless", "onlyIf", "skipIf"].includes(key) &&
        !conditionAllowed(name, joined, branches.map((branch) => branch.description).join(" "))
      )
        add(fieldPath, "condition");
      visit(field, eventName ? [...path, "*"] : fieldPath);
    }
    for (const child of linked(node)) visit(child, path);
    for (const child of Array.isArray(node.items) ? nodes(node.items) : [node.items])
      if (Predicate.isObject(child)) visit(child, [...path, "[]"]);
    if (Predicate.isObject(node.additionalProperties)) visit(node.additionalProperties, [...path, "*"]);
    if (Predicate.isObject(node.patternProperties))
      for (const child of Object.values(node.patternProperties))
        if (Predicate.isObject(child)) visit(child, [...path, "*"]);
    active.delete(node);
  };
  visit(root, []);
  return types;
};

export const editorNamingFindings = (schemas: Editors): readonly Finding[] => {
  const findings = new Set<Finding>();
  const landofile = inspectEditor("LandofileShape", schemas.LandofileShape, findings);
  const global = inspectEditor("GlobalConfig", schemas.GlobalConfig, findings);
  for (const [path, left] of landofile) {
    const right = global.get(path);
    if (
      right !== undefined &&
      left.size > 0 &&
      right.size > 0 &&
      (left.size !== right.size || [...left].some((type) => !right.has(type)))
    )
      findings.add(`LandofileShape.${path} shared-type`);
  }
  return [...findings].sort();
};

const namingDebt = [
  { path: "LandofileShape.agentEnv", rule: "shared-type", issue: 2108 },
  { path: "LandofileShape.events", rule: "shared-type", issue: 2108 },
  { path: "LandofileShape.proxy", rule: "shared-type", issue: 2108 },
  { path: "LandofileShape.services.*.security.certificate-authorities", rule: "casing", issue: 2107 },
  { path: "LandofileShape.services.*.security.certificate-authority", rule: "casing", issue: 2107 },
] as const satisfies readonly {
  readonly path: `${Name}.${string}`;
  readonly rule: Rule;
  readonly issue: 2107 | 2108;
}[];

export const assertEditorSchemaNaming = (schemas: Editors): void => {
  const actual = new Set(editorNamingFindings(schemas));
  const stale = namingDebt.filter(({ path, rule }) => !actual.delete(`${path} ${rule}`));
  if (actual.size > 0 || stale.length > 0)
    throw new Error(
      [
        "Editor schema naming differs from the exact debt ledger:",
        ...[...actual].map((finding) => `New: ${finding}`),
        ...stale.map(({ path, rule, issue }) => `Remove stale debt #${issue}: ${path} ${rule}`),
      ].join("\n"),
    );
};
