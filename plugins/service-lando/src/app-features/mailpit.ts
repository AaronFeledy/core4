import { Effect } from "effect";

import { AppFeatureSelectorMatchedNothingError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { MAILPIT_SMTP_PORT } from "../mailpit-constants.ts";
import { PHP_FEATURE_ID } from "../services/php.ts";

export const mailpitWireFeature: AppFeatureDefinition = {
  id: "service-lando.mailpit.wire",
  priority: 100,
  activatedBy: { services: { type: "mailpit" } },
  selectors: { types: ["mailpit"], hasFeature: [PHP_FEATURE_ID] },
  apply: (ctx) =>
    Effect.gen(function* () {
      const php = ctx.selected.filter((service) => service.featureIds.includes(PHP_FEATURE_ID));
      const unknownTarget = (mailName: string, target: string) =>
        new AppFeatureSelectorMatchedNothingError({
          message: `Mailpit service ${mailName} mailFrom target ${target} is not a resolved PHP service.`,
          feature: ctx.featureId,
          remediation:
            "Choose existing PHP service names in mailFrom, omit it for all PHP services, or set it to false.",
        });
      const wiring = [];
      for (const mail of ctx.selected.filter((service) => service.serviceType === "mailpit")) {
        const authored = mail.normalizedConfig.mailFrom;
        const targets = authored === false ? [] : (authored ?? php.map((service) => service.serviceName));
        for (const target of targets) {
          if (!php.some((service) => service.serviceName === target)) {
            return yield* Effect.fail(unknownTarget(mail.serviceName, target));
          }
        }
        wiring.push({ mail, targets });
      }
      for (const { mail, targets } of wiring) {
        const port = mail.normalizedConfig.port ?? MAILPIT_SMTP_PORT;
        for (const target of targets) {
          const service = ctx.select(target);
          if (service === undefined) {
            return yield* Effect.fail(unknownTarget(mail.serviceName, target));
          }
          service.addEnv("LANDO_MAIL_HOST", mail.serviceName);
          service.addEnv("LANDO_MAIL_PORT", String(port));
          service.addDependency({
            service: ServiceName.make(mail.serviceName),
            condition: "service_started",
            required: true,
          });
          service.addBuildStep({
            id: "service-lando.php:mailpit",
            phase: "build",
            user: "root",
            command: `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends msmtp && printf '%s\\n' 'sendmail_path = "/usr/bin/msmtp --host=${mail.serviceName} --port=${port} --from=lando@localhost -t"' > /usr/local/etc/php/conf.d/zz-lando-mailpit.ini`,
            buildKeyInputs: { mailpit: { host: mail.serviceName, port } },
          });
        }
      }
    }),
};
