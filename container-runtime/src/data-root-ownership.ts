import { LANDO_DATA_ROOT_LABEL, type ResourceOwnership } from "@lando/sdk/schema";

type NativeKind = "container" | "network" | "volume";

export type AdoptionReceipt = {
  readonly nativeName: string;
  readonly dataRoot: string;
  readonly providerId: string;
  readonly appRoot: string;
  readonly appId: string;
} & (
  | { readonly kind: "container" | "network"; readonly nativeId: string }
  | { readonly kind: "volume"; readonly volumeInstance?: string | undefined }
);

export type DataRootResource = {
  readonly kind: NativeKind;
  readonly nativeName: string;
  readonly nativeId?: string | undefined;
  readonly volumeInstance?: string | undefined;
  readonly labels: Readonly<Record<string, string>> | null | undefined;
};

export type DataRootOwnershipContext = {
  readonly dataRoot: string;
  readonly receipts: readonly AdoptionReceipt[];
};

export const adoptionReceiptsFromSummary = (
  summary: ResourceOwnership | undefined,
): readonly AdoptionReceipt[] => {
  if (summary === undefined) return [];
  return (summary.members ?? []).flatMap((member): readonly AdoptionReceipt[] => {
    if (member.dataRoot === undefined) return [];
    const owner = {
      appId: member.appId,
      nativeName: member.nativeName,
      appRoot: summary.appRoot,
      providerId: summary.providerId,
      dataRoot: member.dataRoot,
    };
    switch (member.kind) {
      case "container":
      case "network":
        return member.nativeId ? [{ ...owner, kind: member.kind, nativeId: member.nativeId }] : [];
      case "volume":
        return [{ ...owner, kind: "volume", volumeInstance: member.volumeInstance }];
      default:
        return member.kind satisfies never;
    }
  });
};

export const decideDataRootOwnership = (
  resource: DataRootResource,
  context: DataRootOwnershipContext,
): "owned" | "foreign" | "unknown" => {
  const label = resource.labels?.[LANDO_DATA_ROOT_LABEL];
  if (label !== undefined) return label === context.dataRoot ? "owned" : "foreign";
  return context.receipts.some((receipt) => {
    if (receipt.nativeName !== resource.nativeName || receipt.dataRoot !== context.dataRoot) return false;
    switch (receipt.kind) {
      case "container":
      case "network":
        return receipt.kind === resource.kind && receipt.nativeId === resource.nativeId;
      case "volume":
        return resource.kind === "volume" && receipt.volumeInstance === resource.volumeInstance;
      default:
        return receipt satisfies never;
    }
  })
    ? "owned"
    : "unknown";
};

export const dataRootRefusal = ({ kind, nativeName, labels }: DataRootResource) => {
  const root = labels?.[LANDO_DATA_ROOT_LABEL];
  return root === undefined
    ? {
        message: `Cannot verify which Lando installation owns ${kind} ${nativeName}.`,
        remediation:
          "Use a different app name, or verify and remove the conflicting resource from its owning installation.",
      }
    : {
        message: `${kind} ${nativeName} belongs to the Lando installation with data root ${root}.`,
        remediation: `Run this from that installation (LANDO_USER_DATA_ROOT=${root}) or rename the app.`,
      };
};
