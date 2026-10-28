import { Effect } from "effect";
import * as AST from "effect/SchemaAST";

import { PluginManifestError, SubscriberLevelMismatchError } from "@lando/sdk/errors";
import { LandoEvent } from "@lando/sdk/events";
import type { BootstrapLevel, PluginManifest, SubscriberManifestEntry } from "@lando/sdk/schema";

export interface IndexedSubscriber {
  readonly pluginName: string;
  readonly entry: SubscriberManifestEntry;
}

/**
 * Exact events are indexed. `cli-command-terminal` stays symbolic and is matched
 * by {@link SubscriberIndex.forEvent} at dispatch, including command ids that
 * were not known when registration closed.
 */
export interface SubscriberIndex {
  readonly forEvent: (eventName: string) => ReadonlyArray<IndexedSubscriber>;
  readonly subscribers: ReadonlyArray<IndexedSubscriber>;
}

/**
 * Static command ids come from `builtIns` plus plugin manifest contributions.
 * `appCommandIds` is present only when an authoritative app catalog was loaded.
 * Absence is not an empty catalog: unknown `app:*` exact selectors stay deferred.
 */
export interface SubscriberRegistrationInput {
  readonly builtIns?: ReadonlyArray<string>;
  readonly appCommandIds?: ReadonlyArray<string>;
}

interface SubscriberRegistrationClosure {
  readonly current: () => SubscriberIndex | undefined;
  readonly close: (
    input?: SubscriberRegistrationInput,
  ) => Effect.Effect<SubscriberIndex, PluginManifestError | SubscriberLevelMismatchError>;
}

type BootstrapEventTag = Extract<LandoEvent["_tag"], `${"pre" | "post"}-bootstrap-${string}`>;
type BootstrapLevelFromTag<Tag extends string> = Tag extends `${"pre" | "post"}-bootstrap-${infer Level}`
  ? Level
  : never;
type BootstrapEventLevel = BootstrapLevelFromTag<BootstrapEventTag>;

type RegisteredSubscriber = IndexedSubscriber & {
  readonly declaredLevel: BootstrapLevel;
  readonly ordinal: number;
};

// Tooling keys are strings; require nonempty, non-whitespace, non-glob segments.
// The end-of-input assertion also excludes a trailing newline (unlike `$`).
const CANONICAL_COMMAND_ID = /^[a-z][a-z0-9-]*(?::[^:\s*?[\]{}]+)+(?![\s\S])/;
const CLI_EVENT_PREFIX = "cli-";
const NO_SUBSCRIBERS: ReadonlyArray<RegisteredSubscriber> = [];

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
} satisfies Record<BootstrapEventTag, BootstrapEventLevel>;

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

const isCliPhase = (value: string): value is "init" | "run" | "error" =>
  value === "init" || value === "run" || value === "error";

const parseCliEvent = (
  event: string,
): { readonly commandId: string; readonly phase: "init" | "run" | "error" } | undefined => {
  if (!event.startsWith(CLI_EVENT_PREFIX)) return undefined;
  const separator = event.lastIndexOf("-");
  if (separator < CLI_EVENT_PREFIX.length) return undefined;
  const phase = event.slice(separator + 1);
  if (!isCliPhase(phase)) return undefined;
  return { commandId: event.slice(CLI_EVENT_PREFIX.length, separator), phase };
};

const isCanonicalCommandId = (commandId: string): boolean => CANONICAL_COMMAND_ID.test(commandId);

/** Landofile-derived commands use `app:`. `apps:` is a static built-in namespace. */
const isDynamicAppCommandId = (commandId: string): boolean => commandId.startsWith("app:");

const terminalCommandId = (eventName: string, catalog: SubscriberEventCatalog): string | undefined => {
  const parsed = parseCliEvent(eventName);
  if (parsed === undefined || parsed.phase === "init") return undefined;
  return catalog.commands.has(parsed.commandId) ||
    catalog.appCommands?.has(parsed.commandId) ||
    isCanonicalCommandId(parsed.commandId)
    ? parsed.commandId
    : undefined;
};

export const staticSubscriberCommandIds = (
  manifests: ReadonlyArray<PluginManifest>,
  builtIns: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const ids = new Set<string>(builtIns);
  for (const manifest of manifests) {
    for (const command of manifest.contributes?.commands ?? []) {
      ids.add(typeof command === "string" ? command : command.id);
    }
  }
  return ids;
};

const compareSubscribers = (left: RegisteredSubscriber, right: RegisteredSubscriber): number =>
  left.entry.priority - right.entry.priority || left.ordinal - right.ordinal;

const builtInEventNames = (): Set<string> => {
  const names = new Set<string>();
  if (!AST.isUnion(LandoEvent.ast)) return names;
  for (const member of LandoEvent.ast.types) {
    if (!AST.isObjects(member)) continue;
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
    issues: [{ path: [], message: `Unknown event: ${event}` }],
    remediation: `Change subscriber "${subscriber.entry.id}" to select a registered lifecycle event.`,
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

interface SubscriberEventCatalog {
  readonly events: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly appCommands: ReadonlySet<string> | undefined;
}

const acceptsExactEvent = (event: string, catalog: SubscriberEventCatalog): boolean => {
  if (catalog.events.has(event)) return true;
  const parsed = parseCliEvent(event);
  if (parsed === undefined) return false;
  if (catalog.commands.has(parsed.commandId) || catalog.appCommands?.has(parsed.commandId)) return true;
  if (!isCanonicalCommandId(parsed.commandId)) return false;
  if (!isDynamicAppCommandId(parsed.commandId)) return false;
  return catalog.appCommands === undefined || catalog.appCommands.has(parsed.commandId);
};

const forEvent = (
  exact: ReadonlyMap<string, ReadonlyArray<RegisteredSubscriber>>,
  family: ReadonlyArray<RegisteredSubscriber>,
  eventName: string,
): ReadonlyArray<IndexedSubscriber> => {
  const exactEntries = exact.get(eventName) ?? NO_SUBSCRIBERS;
  if (family.length === 0) return exactEntries;
  return [...new Set([...exactEntries, ...family])].sort(compareSubscribers);
};

export const makeSubscriberRegistrationClosure = (
  manifests: ReadonlyArray<PluginManifest>,
): SubscriberRegistrationClosure => {
  let index: SubscriberIndex | undefined;
  let ordinal = 0;
  const declared = manifests.flatMap((manifest) =>
    (manifest.subscribers ?? []).map(
      (entry): RegisteredSubscriber => ({
        pluginName: String(manifest.name),
        declaredLevel: manifest.bootstrap,
        ordinal: ordinal++,
        entry,
      }),
    ),
  );

  return {
    current: () => index,
    close: Effect.fn("Lifecycle.closeSubscriberRegistration")(function* (
      input?: SubscriberRegistrationInput,
    ) {
      if (index !== undefined) return index;
      const catalog: SubscriberEventCatalog = {
        events: builtInEventNames(),
        commands: staticSubscriberCommandIds(manifests, input?.builtIns ?? []),
        appCommands: input?.appCommandIds === undefined ? undefined : new Set(input.appCommandIds),
      };
      const exact = new Map<string, RegisteredSubscriber[]>();
      const family: RegisteredSubscriber[] = [];

      for (const subscriber of declared) {
        for (const selector of subscriber.entry.selectors) {
          if (!("event" in selector)) {
            if (!family.includes(subscriber)) family.push(subscriber);
            continue;
          }
          if (!acceptsExactEvent(selector.event, catalog)) {
            return yield* Effect.fail(manifestError(subscriber, selector.event));
          }
          const eventLevel = BOOTSTRAP_EVENT_LEVELS[selector.event];
          if (
            eventLevel !== undefined &&
            !BOOTSTRAP_EVENT_COVERAGE[subscriber.declaredLevel].some(
              (coveredLevel) => coveredLevel === eventLevel,
            )
          ) {
            return yield* Effect.fail(levelMismatchError(subscriber, selector.event, eventLevel));
          }
          const entries = exact.get(selector.event) ?? [];
          if (!entries.includes(subscriber)) entries.push(subscriber);
          exact.set(selector.event, entries);
        }
      }
      for (const entries of exact.values()) entries.sort(compareSubscribers);

      index = {
        subscribers: declared,
        forEvent: (eventName) =>
          forEvent(
            exact,
            terminalCommandId(eventName, catalog) === undefined ? NO_SUBSCRIBERS : family,
            eventName,
          ),
      };
      return index;
    }),
  };
};
