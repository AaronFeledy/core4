import { AppLifecycleEventName } from "@lando/sdk/schema";

export const VALID_APP_LIFECYCLE_EVENTS = AppLifecycleEventName.literals;

export const unknownAppLifecycleEvent = (parsed: unknown): string | undefined => {
  if (parsed === null || typeof parsed !== "object" || !("events" in parsed)) return undefined;
  const events = parsed.events;
  if (events === null || typeof events !== "object" || Array.isArray(events)) return undefined;
  return Object.keys(events).find(
    (name) => !VALID_APP_LIFECYCLE_EVENTS.some((validName) => validName === name),
  );
};
