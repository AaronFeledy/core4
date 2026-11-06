import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import {
  type BucketSite,
  INTERNAL_PERSISTED_STORES,
  UNREGISTERED_DURABLE_BUCKETS,
} from "../../../scripts/schema-compatibility/internal-stores.ts";
import {
  enumFields,
  findDurableBucketSites,
  lifecycleProblems,
} from "../../../scripts/schema-compatibility/store-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const siteKey = ({ file, schema }: BucketSite): string => `${file} (schema: ${schema})`;

describe("durable StateStore buckets", () => {
  test("every durable bucket spec is registered or exempted, and every listing still matches a spec", async () => {
    const sites = await findDurableBucketSites(REPO_ROOT);
    const listed = [
      ...INTERNAL_PERSISTED_STORES.map((store) => ({ key: siteKey(store.source), owner: store.id })),
      ...UNREGISTERED_DURABLE_BUCKETS.map((site) => ({ key: siteKey(site), owner: "exemption" })),
    ];
    const listedKeys = new Set(listed.map(({ key }) => key));
    const siteKeys = new Set(sites.map(siteKey));

    const unlisted = sites
      .filter((site) => !listedKeys.has(siteKey(site)))
      .map(
        (site) =>
          `${site.file}:${site.line} opens durable bucket schema ${site.schema}; register it in INTERNAL_PERSISTED_STORES or exempt it in UNREGISTERED_DURABLE_BUCKETS with a reason.`,
      );
    const stale = listed
      .filter(({ key }) => !siteKeys.has(key))
      .map(({ key, owner }) => `${owner}: ${key} no longer matches a durable bucket spec.`);
    const duplicated = listed
      .filter(({ key }, index) => listed.findIndex((other) => other.key === key) !== index)
      .map(({ key }) => `${key} is listed more than once.`);

    expect(sites.length).toBeGreaterThan(0);
    expect([...unlisted, ...stale, ...duplicated]).toEqual([]);
  });

  test.each(INTERNAL_PERSISTED_STORES.map((store) => [store.id, store] as const))(
    "%s declares the lifecycle of every stored status, phase, or state enum",
    (_id, store) => {
      const document = getJsonSchemaWithDeprecations(store.schema, { onExcessProperty: "ignore" });

      expect(lifecycleProblems(store.lifecycle, enumFields(document))).toEqual([]);
    },
  );
});
