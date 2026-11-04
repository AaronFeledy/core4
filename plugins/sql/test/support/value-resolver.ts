import { SecretNotFoundError } from "@lando/sdk/errors";
import { type Environment, type EnvironmentValue, encodeUriComponent } from "@lando/sdk/schema";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import { Effect } from "effect";

export const valueResolver = (values: Readonly<Record<string, string>>) => {
  const reads: string[] = [];
  const environments: Array<Readonly<Record<string, EnvironmentValue>>> = [];
  let sessions = 0;
  const resolver: EnvironmentValueResolver["Service"] = {
    openSession: () =>
      Effect.sync(() => {
        sessions += 1;
        const memo = new Map<string, string>();
        const resolveReference = Effect.fnUntraced(function* (reference: string) {
          const cached = memo.get(reference);
          if (cached !== undefined) return cached;
          reads.push(reference);
          const value = values[reference];
          if (value === undefined)
            return yield* Effect.fail(
              new SecretNotFoundError({ message: "Missing fixture reference", secret: reference }),
            );
          memo.set(reference, value);
          return value;
        });
        const resolveValue = Effect.fnUntraced(function* (value: EnvironmentValue) {
          if (typeof value === "string") return value;
          switch (value._tag) {
            case "SecretRef":
              return yield* resolveReference(value.reference);
            case "BoundText": {
              let result = "";
              for (const part of value.parts) {
                if (typeof part === "string") result += part;
                else {
                  const raw = yield* resolveReference(part.reference);
                  result += part.encoding === "uri-component" ? encodeUriComponent(raw) : raw;
                }
              }
              return result;
            }
          }
        });
        return {
          resolveEnvironment: Effect.fnUntraced(function* (environment: Environment) {
            environments.push(environment);
            const concrete: Record<string, string> = {};
            for (const [key, value] of Object.entries(environment))
              concrete[key] = yield* resolveValue(value);
            return concrete;
          }),
        };
      }),
  };
  return { resolver, reads, environments, sessions: () => sessions };
};
