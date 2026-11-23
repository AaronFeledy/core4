import { ProviderUnavailableError, appliedStateVersionError } from "@lando/sdk/errors";
import type { ProviderId, UnreadableAppliedState } from "@lando/sdk/schema";

/**
 * The tagged failure an inventory issue stands for: newer state keeps the run-or-upgrade
 * remediation, an unreadable record asks for a restore before `retryCommand` runs again.
 */
export const appliedStateIssueError = (
  providerId: ProviderId,
  issue: UnreadableAppliedState,
  retryCommand: string,
) =>
  issue.reason === "newer-version"
    ? appliedStateVersionError({
        path: issue.path,
        storedVersion: issue.storedVersion,
        supportedVersion: issue.supportedVersion,
        ...(issue.appId === undefined ? {} : { appId: issue.appId }),
        providerId,
        operation: "applied-state.list",
        scope: issue.appId === undefined ? "provider" : "app",
      })
    : new ProviderUnavailableError({
        providerId,
        operation: "applied-state.list",
        message: `Applied-state record "${issue.path}" could not be read.`,
        remediation: `Restore a readable applied-state record from a trusted backup or remove the corrupt file, then retry \`${retryCommand}\`.`,
      });
