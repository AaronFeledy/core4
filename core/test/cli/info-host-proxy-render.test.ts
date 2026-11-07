import { expect, test } from "bun:test";
import type { InfoAppResult } from "@lando/sdk/schema";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, result, service } from "./info-storage-fixtures.ts";

test.each(["available", "unavailable", undefined] as const)(
  "human info shows only applicable host-proxy unavailability: %s",
  (availability) => {
    // Given
    const info: InfoAppResult = {
      ...result(service("web", [])),
      ...(availability === undefined
        ? {}
        : {
            hostProxy: {
              runLando: {
                availability,
                ...(availability === "unavailable" ? { reason: "Provider has no container target." } : {}),
              },
            },
          }),
    };
    // When
    const section = buildInfoSummary(info).sections.find(({ title }) => title === "host-proxy");
    const human = [renderInfoAppResult(info), renderInfoAppResult(info, decorated(160))];
    // Then
    if (availability === "unavailable") {
      expect(section?.rows[0]).toMatchObject({
        value: "unavailable",
        fields: [{ label: "reason", value: "Provider has no container target." }],
      });
      for (const text of human) expect(text).toContain("host-proxy");
    } else {
      expect(section).toBeUndefined();
      for (const text of human) expect(text).not.toContain("host-proxy");
    }
  },
);
