import { expect, test } from "bun:test";
import { LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import {
  type AdoptionReceipt,
  type DataRootResource,
  decideDataRootOwnership,
} from "../src/data-root-ownership.ts";

const dataRoot = "/roots/local";
const receiptOwner = { dataRoot, appRoot: "/apps/demo", appId: "demo", providerId: "docker" };
const receipts: readonly AdoptionReceipt[] = [
  { ...receiptOwner, kind: "container", nativeName: "demo-web", nativeId: "container-id" },
  { ...receiptOwner, kind: "network", nativeName: "demo-net", nativeId: "network-id" },
  { ...receiptOwner, kind: "volume", nativeName: "demo-db", volumeInstance: "instance-id" },
  { ...receiptOwner, kind: "volume", nativeName: "old-cache" },
];
const container = {
  kind: "container",
  nativeName: "demo-web",
  nativeId: "container-id",
  labels: {},
} as const;
const network = { kind: "network", nativeName: "demo-net", nativeId: "network-id", labels: {} } as const;
const volume = { kind: "volume", nativeName: "demo-db", volumeInstance: "instance-id", labels: {} } as const;
const table: readonly [string, DataRootResource, string, ReturnType<typeof decideDataRootOwnership>][] = [
  [
    "owns an equal label without a receipt",
    { ...container, nativeName: "new", labels: { [LANDO_DATA_ROOT_LABEL]: dataRoot } },
    dataRoot,
    "owned",
  ],
  [
    "a peer label vetoes a matching receipt",
    { ...container, labels: { [LANDO_DATA_ROOT_LABEL]: "/roots/peer" } },
    dataRoot,
    "foreign",
  ],
  ["owns an exact container receipt", container, dataRoot, "owned"],
  ["owns an exact network receipt", network, dataRoot, "owned"],
  ["owns an exact volume receipt", volume, dataRoot, "owned"],
  [
    "does not transfer a receipt to a replacement container",
    { ...container, nativeId: "replacement" },
    dataRoot,
    "unknown",
  ],
  ["requires a network ID", { ...network, nativeId: undefined }, dataRoot, "unknown"],
  [
    "does not transfer a receipt to a replacement volume",
    { ...volume, volumeInstance: "replacement" },
    dataRoot,
    "unknown",
  ],
  [
    "does not downgrade a witnessed volume receipt",
    { ...volume, volumeInstance: undefined },
    dataRoot,
    "unknown",
  ],
  [
    "owns a receipted volume that predates instance labels",
    { ...volume, nativeName: "old-cache", volumeInstance: undefined },
    dataRoot,
    "owned",
  ],
  [
    "does not transfer an instance-less receipt to a witnessed volume",
    { ...volume, nativeName: "old-cache" },
    dataRoot,
    "unknown",
  ],
  ["requires the same kind", { ...container, kind: "network" }, dataRoot, "unknown"],
  ["requires the same native name", { ...container, nativeName: "other" }, dataRoot, "unknown"],
  ["ignores a receipt from a different root", container, "/roots/peer", "unknown"],
];

for (const [description, resource, root, expected] of table) {
  test(description, () => {
    expect(decideDataRootOwnership(resource, { dataRoot: root, receipts })).toBe(expected);
  });
}
