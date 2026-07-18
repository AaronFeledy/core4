import { Effect } from "effect";
import * as AST from "effect/SchemaAST";

import { PluginManifestError } from "@lando/sdk/errors";
import { LandoEvent } from "@lando/sdk/events";
import type { PluginManifest, SubscriberManifestEntry } from "@lando/sdk/schema";

export interface IndexedSubscriber {
  readonly pluginName: string;
  readonly entry: SubscriberManifestEntry;
}

export type SubscriberRegistrationCompleteness = "final" | "provisional";

export interface SubscriberRegistrationClosure {
  readonly current: () => ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>> | undefined;
  readonly close: (
    commandIds: ReadonlyArray<string>,
    completeness?: SubscriberRegistrationCompleteness,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>>, PluginManifestError>;
}

const builtInEventNames = (): ReadonlySet<string> => {
  const names = new Set<string>();
  if (!AST.isUnion(LandoEvent.ast)) return names;
  for (const member of LandoEvent.ast.types) {
    if (!AST.isTypeLiteral(member)) continue;
    const tag = member.propertySignatures.find((property) => property.name === "_tag")?.type;
    if (tag !== undefined && AST.isLiteral(tag) && typeof tag.literal === "string") {
      names.add(tag.literal);
    }
  }
  return names;
};

const manifestError = (subscriber: IndexedSubscriber, event: string): PluginManifestError =>
  new PluginManifestError({
    message: `Subscriber "${subscriber.entry.id}" from ${subscriber.pluginName} selects unknown event "${event}".`,
    issues: [event],
  });

const isCliLifecycleEvent = (event: string): boolean => /^cli-.+-(?:init|run|error)$/u.test(event);

export const makeSubscriberRegistrationClosure = (
  manifests: ReadonlyArray<PluginManifest>,
): SubscriberRegistrationClosure => {
  let index: ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>> | undefined;
  const subscribers = manifests.flatMap((manifest) =>
    (manifest.subscribers ?? []).map((entry) => ({ pluginName: String(manifest.name), entry })),
  );

  return {
    current: () => index,
    close: (commandIds, completeness = "final") => {
      if (index !== undefined) return Effect.succeed(index);
      return Effect.gen(function* () {
        const known = new Set(builtInEventNames());
        for (const commandId of commandIds) {
          known.add(`cli-${commandId}-init`);
          known.add(`cli-${commandId}-run`);
          known.add(`cli-${commandId}-error`);
        }

        const mutable = new Map<string, Array<IndexedSubscriber>>();
        for (const subscriber of subscribers) {
          for (const selector of subscriber.entry.selectors) {
            const isExact = "event" in selector;
            const events = isExact
              ? [selector.event]
              : commandIds.flatMap((commandId) => [`cli-${commandId}-run`, `cli-${commandId}-error`]);
            for (const event of events) {
              const membershipDeferred =
                completeness === "provisional" && isExact && isCliLifecycleEvent(event);
              if (!known.has(event) && !membershipDeferred) {
                return yield* Effect.fail(manifestError(subscriber, event));
              }
              const entries = mutable.get(event) ?? [];
              if (!entries.includes(subscriber)) entries.push(subscriber);
              mutable.set(event, entries);
            }
          }
        }
        for (const entries of mutable.values()) {
          entries.sort((left, right) => left.entry.priority - right.entry.priority);
        }
        index = mutable;
        return index;
      });
    },
  };
};
