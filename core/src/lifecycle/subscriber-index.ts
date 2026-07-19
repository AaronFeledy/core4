import { Effect } from "effect";
import * as AST from "effect/SchemaAST";

import { PluginManifestError, SubscriberLevelMismatchError } from "@lando/sdk/errors";
import { LandoEvent } from "@lando/sdk/events";
import type { BootstrapLevel, PluginManifest, SubscriberManifestEntry } from "@lando/sdk/schema";

export interface IndexedSubscriber {
  readonly pluginName: string;
  readonly entry: SubscriberManifestEntry;
}

interface SubscriberRegistrationClosure {
  readonly current: () => ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>> | undefined;
  readonly close: (
    commandIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>>,
    PluginManifestError | SubscriberLevelMismatchError
  >;
}

type BootstrapEventLevel = "minimal" | "plugins" | "commands" | "tooling" | "provider" | "app";

type RegisteredSubscriber = IndexedSubscriber & {
  readonly declaredLevel: BootstrapLevel;
};

const BOOTSTRAP_EVENT_LEVELS: Readonly<Record<string, BootstrapEventLevel>> = {
  "pre-bootstrap-minimal": "minimal",
  "post-bootstrap-minimal": "minimal",
  "pre-bootstrap-plugins": "plugins",
  "post-bootstrap-plugins": "plugins",
  "pre-bootstrap-commands": "commands",
  "post-bootstrap-commands": "commands",
  "pre-bootstrap-tooling": "tooling",
  "post-bootstrap-tooling": "tooling",
  "pre-bootstrap-provider": "provider",
  "post-bootstrap-provider": "provider",
  "pre-bootstrap-app": "app",
  "post-bootstrap-app": "app",
};

const BOOTSTRAP_EVENT_COVERAGE = {
  none: [],
  minimal: ["minimal"],
  plugins: ["minimal", "plugins"],
  commands: ["minimal", "plugins", "commands"],
  tooling: ["minimal", "plugins", "commands", "tooling"],
  provider: ["minimal", "plugins", "commands", "provider"],
  global: ["minimal", "plugins", "commands", "provider"],
  scratch: ["minimal", "plugins", "commands", "provider"],
  app: ["minimal", "plugins", "commands", "provider", "app"],
} as const satisfies Record<BootstrapLevel, ReadonlyArray<BootstrapEventLevel>>;

const builtInEventNames = (): Set<string> => {
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

const levelMismatchError = (
  subscriber: RegisteredSubscriber,
  event: string,
  eventLevel: BootstrapEventLevel,
): SubscriberLevelMismatchError =>
  new SubscriberLevelMismatchError({
    pluginName: subscriber.pluginName,
    subscriberId: subscriber.entry.id,
    selectedEvent: event,
    declaredLevel: subscriber.declaredLevel,
    eventLevel,
    message: `Subscriber "${subscriber.entry.id}" from ${subscriber.pluginName} cannot select "${event}" at declared bootstrap level "${subscriber.declaredLevel}".`,
    remediation: `Declare bootstrap: "${eventLevel}" or select an event covered by bootstrap level "${subscriber.declaredLevel}".`,
  });

export const makeSubscriberRegistrationClosure = (
  manifests: ReadonlyArray<PluginManifest>,
): SubscriberRegistrationClosure => {
  let index: ReadonlyMap<string, ReadonlyArray<IndexedSubscriber>> | undefined;
  const subscribers = manifests.flatMap((manifest) =>
    (manifest.subscribers ?? []).map((entry) => ({
      pluginName: String(manifest.name),
      declaredLevel: manifest.bootstrap,
      entry,
    })),
  );

  return {
    current: () => index,
    close: (commandIds) => {
      if (index !== undefined) return Effect.succeed(index);
      return Effect.gen(function* () {
        const known = builtInEventNames();
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
              if (!known.has(event)) {
                return yield* Effect.fail(manifestError(subscriber, event));
              }
              const eventLevel = isExact ? BOOTSTRAP_EVENT_LEVELS[event] : undefined;
              if (
                eventLevel !== undefined &&
                !BOOTSTRAP_EVENT_COVERAGE[subscriber.declaredLevel].some(
                  (coveredLevel) => coveredLevel === eventLevel,
                )
              ) {
                return yield* Effect.fail(levelMismatchError(subscriber, event, eventLevel));
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
