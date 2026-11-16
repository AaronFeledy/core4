import { MessageInfoEvent } from "@lando/sdk/events";
import type { ServiceContainerChange } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

const joinItems = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const replacementReason = (reason: ServiceContainerChange["reason"]): string => {
  switch (reason) {
    case "config":
      return "its configuration changed";
    case "publish-port":
      return "its published ports changed";
    case "bind-source":
      return "a mounted host path changed";
    case "network":
      return "it was missing a network";
    case "host-port":
      return "its host port was taken";
    default:
      return "it was recreated on request";
  }
};

const anonymousVolumeNotice = (volumes: ReadonlyArray<string>): string =>
  volumes.length <= 1
    ? `Its anonymous volume at ${volumes[0] ?? ""} went with it; declare that path under storage: to keep its data.`
    : `Its anonymous volumes at ${joinItems(volumes)} went with it; declare those paths under storage: to keep their data.`;

const replacedNotice = (name: string, change: ServiceContainerChange): string =>
  `Lando replaced ${name}'s container because ${replacementReason(change.reason)}.${
    change.anonymousVolumes === undefined || change.anonymousVolumes.length === 0
      ? ""
      : ` ${anonymousVolumeNotice(change.anonymousVolumes)}`
  }`;

const createdNotice = (services: ReadonlyArray<string>): string =>
  services.length === 1
    ? `${services[0]} had no container, so Lando created one.`
    : `${joinItems(services)} had no containers, so Lando created them.`;

/**
 * Announces what apply did to containers from the provider's `ApplyResult.services`: one message per
 * replaced service, and one combined message for created services when the caller asks for them.
 * A provider that omits the report produces no notice.
 */
export const publishApplyOutcomeNotices = Effect.fnUntraced(function* (
  events: Pick<EventService["Service"], "publish">,
  services: Readonly<Record<string, ServiceContainerChange>> | undefined,
  options: { readonly created: boolean },
) {
  if (services === undefined) return;
  for (const [name, change] of Object.entries(services)) {
    if (change.action !== "replaced") continue;
    yield* events.publish(
      MessageInfoEvent.make({ body: replacedNotice(name, change), timestamp: DateTime.nowUnsafe() }),
    );
  }
  if (!options.created) return;
  const created = Object.entries(services)
    .filter(([, change]) => change.action === "created")
    .map(([name]) => name);
  if (created.length === 0) return;
  yield* events.publish(
    MessageInfoEvent.make({ body: createdNotice(created), timestamp: DateTime.nowUnsafe() }),
  );
});
