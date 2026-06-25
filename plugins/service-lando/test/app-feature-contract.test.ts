import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AppFeatureDefinition } from "@lando/sdk/services";
import { runAppFeatureContract } from "@lando/sdk/test";

describe("service-lando catalog × app-feature contract suite", () => {
  test("mailpit-style php SMTP app feature satisfies runAppFeatureContract", async () => {
    const mailpitSmtp: AppFeatureDefinition = {
      id: "service-lando.mailpit.smtp",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      requires: { globalServices: ["mailpit"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => {
            service.addEnv("MAIL_HOST", "mailpit.global.internal");
            service.addEnv("MAIL_PORT", "1025");
          });
        }),
    };

    return expect(
      Effect.runPromise(
        runAppFeatureContract({
          feature: mailpitSmtp,
          services: [
            { serviceName: "appserver", serviceType: "php", base: "lando", framework: "drupal" },
            { serviceName: "node", serviceType: "node", base: "lando" },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
