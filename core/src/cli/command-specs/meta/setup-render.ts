/**
 * `meta:setup` human rendering: the decorated summary box, or plain lines when
 * the context is not decorated. Machine output never reaches this module.
 */
import { SetupProviderSwitchResultSchema } from "@lando/engine/operations/setup-provider-switch";
import { formatSummary } from "@lando/renderer/summary";
import { TrustStoreChange } from "@lando/sdk/schema";
import { Schema } from "effect";

import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";
import { buildSetupSummary, caInjectionNote, fileSyncStatusLine, trustStoreLine } from "./setup-summary";

const isTrustStores = Schema.is(Schema.Array(TrustStoreChange));

export const renderSetupResult = (
  result: unknown,
  _input?: unknown,
  ctx?: RenderContext,
): string | undefined => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("providerId" in result) ||
    !("installDir" in result) ||
    !("networkCaInjectionConfigured" in result) ||
    typeof result.networkCaInjectionConfigured !== "boolean"
  ) {
    return undefined;
  }
  const status = "fileSyncStatus" in result ? String(result.fileSyncStatus) : "satisfied";
  const providerId = String(result.providerId);
  const installDir = String(result.installDir);
  const trustStores = "trustStores" in result && isTrustStores(result.trustStores) ? result.trustStores : [];
  const notes = result.networkCaInjectionConfigured ? [caInjectionNote] : [];
  if ("providerSwitch" in result && Schema.is(SetupProviderSwitchResultSchema)(result.providerSwitch)) {
    const switched = result.providerSwitch;
    notes.push(
      `Global services switched from ${switched.fromProviderId} to ${switched.toProviderId}; old volumes and router configuration were kept.`,
    );
    for (const app of switched.remainingApps)
      notes.push(
        `${app.id} remains on ${switched.fromProviderId}. In ${app.root}, run \`lando destroy --provider=${switched.fromProviderId} --yes\`, then \`lando start\`. A Landofile \`provider:\` still pins the app. Data volumes are not copied.`,
      );
  }
  if (process.platform === "win32") {
    notes.push(
      "To keep Lando on PATH in new PowerShell sessions, create `$PROFILE` if needed, then append the output of `lando shellenv --shell=powershell` to it. Keep any existing profile content.",
    );
  }
  if (isDecoratedContext(ctx))
    return formatSummary(
      buildSetupSummary({ providerId, installDir, fileSyncStatus: status, notes, trustStores }),
      summaryPaintOptions(ctx),
    );
  const lines = [
    `setup complete: Lando runtime (${providerId})`,
    fileSyncStatusLine(status),
    `LANDO_INSTALL_DIR="${installDir}"`,
    ...trustStores.map(trustStoreLine),
    ...notes,
  ];
  return lines.join("\n");
};
