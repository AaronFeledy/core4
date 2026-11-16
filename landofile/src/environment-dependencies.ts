import type { ExpressionNode, ExpressionTemplate } from "@lando/sdk/expressions";
import { expressionScopeMembers } from "@lando/sdk/expressions";

/** Names the load read, or the full environment when enumeration was required. */
export type EnvironmentDependencies =
  | { readonly _tag: "Names"; readonly names: readonly string[] }
  | { readonly _tag: "Complete" };

export const emptyEnvironmentDependencies = (): EnvironmentDependencies => ({
  _tag: "Names",
  names: [],
});

/** Merge dependency sets; any `Complete` arm wins. */
export const unionEnvironmentDependencies = (
  ...parts: readonly EnvironmentDependencies[]
): EnvironmentDependencies => {
  const names = new Set<string>();
  for (const part of parts) {
    if (part._tag === "Complete") return { _tag: "Complete" };
    for (const name of part.names) names.add(name);
  }
  return { _tag: "Names", names: [...names].sort() };
};

export interface EnvironmentRecorder {
  /**
   * Read-only view over the captured environment. `get` / `has` /
   * `getOwnPropertyDescriptor` with a string key record that name; `ownKeys`
   * records `Complete`; mutation traps return false. Symbol keys are ignored.
   */
  readonly view: Readonly<Record<string, string | undefined>>;
  /** Snapshot of names recorded so far (or `Complete`). Does not clear. */
  dependencies(): EnvironmentDependencies;
  /** Record statically known names (unset names still count). No-op once Complete. */
  recordNames(names: Iterable<string>): void;
  /** Mark the dependency set as the complete environment. */
  recordComplete(): void;
}

/**
 * Build a recorder over a captured environment snapshot.
 * `env` must already be the caller's captured copy — never live `process.env`.
 */
export const recordEnvironment = (env: Readonly<Record<string, string | undefined>>): EnvironmentRecorder => {
  const target: Record<string, string | undefined> = { ...env };
  const names = new Set<string>();
  let complete = false;

  const recordName = (key: string | symbol): void => {
    if (complete || typeof key !== "string") return;
    names.add(key);
  };

  const view = new Proxy(target, {
    get(source, property, receiver) {
      recordName(property);
      return Reflect.get(source, property, receiver);
    },
    has(source, property) {
      recordName(property);
      return Reflect.has(source, property);
    },
    getOwnPropertyDescriptor(source, property) {
      recordName(property);
      return Reflect.getOwnPropertyDescriptor(source, property);
    },
    ownKeys(source) {
      complete = true;
      return Reflect.ownKeys(source);
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });

  return {
    view,
    dependencies: () => (complete ? { _tag: "Complete" } : { _tag: "Names", names: [...names].sort() }),
    recordNames: (next) => {
      if (complete) return;
      for (const name of next) names.add(name);
    },
    recordComplete: () => {
      complete = true;
    },
  };
};

/**
 * Record env members named by a parsed expression, including `${NAME}` shell
 * parameters. Unanalyzable members mark `Complete`. Call for every env-scoped
 * site the load parses, deferred or not.
 */
export const recordExpressionEnvironment = (
  recorder: EnvironmentRecorder,
  ast: ExpressionTemplate | ExpressionNode,
): void => {
  const members = expressionScopeMembers(ast, "env");
  if (!members.analyzable) {
    recorder.recordComplete();
    return;
  }
  recorder.recordNames(members.members);
  if ("whole" in ast)
    for (const segment of ast.segments)
      if (segment.kind === "ShellParamSegment") recorder.recordNames([segment.name]);
};
