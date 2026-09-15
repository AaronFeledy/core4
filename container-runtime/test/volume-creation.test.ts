import { expect, test } from "bun:test";

import { AbsolutePath } from "@lando/sdk/schema";
import { volumeCreationFact } from "../src/volume-creation.ts";

const labels = { "dev.lando.volume-instance": "new-request-token", "dev.lando.volume-owner": "/owner" };

test("reports creation when the daemon echoes this request's token and owner", () => {
  const body = JSON.stringify({ Name: "data", Labels: labels });
  const facts = volumeCreationFact({ body, name: "data", labels });
  expect(facts).toEqual([
    { nativeName: "data", generation: "new-request-token", ownerRoot: AbsolutePath.make("/owner") },
  ]);
});

test.each([
  { Name: "data", Labels: { ...labels, "dev.lando.volume-instance": "existing-token" } },
  { Name: "data", Labels: {} },
  { Name: "other", Labels: labels },
  { Name: "data", Labels: { ...labels, "dev.lando.volume-owner": "/other" } },
  {},
])("does not report existing, adopted, mismatched, or unknown creation evidence: %j", (response) => {
  const body = JSON.stringify(response);
  const facts = volumeCreationFact({ body, name: "data", labels });
  expect(facts).toEqual([]);
});
