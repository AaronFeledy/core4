import { Effect } from "effect";

import { AppFeatureSelectorMatchedNothingError, MailpitMsmtpBaseFamilyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { MAILPIT_SMTP_PORT } from "../mailpit-constants.ts";
import {
  MSMTP_SUPPORTED_FAMILIES,
  type MsmtpFamilyPin,
  msmtpBuildKeyInput,
  msmtpBuildStepCommand,
  msmtpPinFor,
  resolveMsmtpBaseFamily,
} from "../services/php-msmtp.ts";
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
      const unprovableFamily = (target: string, image: string | undefined) =>
        new MailpitMsmtpBaseFamilyError({
          message: `Mailpit cannot pin msmtp for PHP service ${target}: image ${image ?? "(none)"} proves no supported base image family.`,
          feature: ctx.featureId,
          remediation: `Use a canonical php:<version>-<via>-bookworm or php:<version>-<via>-bullseye image (supported families: ${MSMTP_SUPPORTED_FAMILIES.join(", ")}), or leave ${target} out of mailFrom (list the other services, or set mailFrom: false).`,
        });
      const wiring: Array<{
        readonly mail: (typeof ctx.selected)[number];
        readonly targets: ReadonlyArray<{ readonly name: string; readonly pin: MsmtpFamilyPin }>;
      }> = [];
      for (const mail of ctx.selected.filter((service) => service.serviceType === "mailpit")) {
        const authored = mail.normalizedConfig.mailFrom;
        const names = authored === false ? [] : (authored ?? php.map((service) => service.serviceName));
        const targets = [];
        for (const name of names) {
          const sender = php.find((service) => service.serviceName === name);
          if (sender === undefined) {
            return yield* Effect.fail(unknownTarget(mail.serviceName, name));
          }
          // Refuse before any mutation: a sender whose image proves no family
          // has no reproducible msmtp source, and Lando never guesses one.
          const family = resolveMsmtpBaseFamily(sender.normalizedConfig);
          if (family === undefined) {
            return yield* Effect.fail(unprovableFamily(name, sender.normalizedConfig.image));
          }
          targets.push({ name: String(name), pin: msmtpPinFor(family) });
        }
        wiring.push({ mail, targets });
      }
      for (const { mail, targets } of wiring) {
        const port = mail.normalizedConfig.port ?? MAILPIT_SMTP_PORT;
        for (const { name: target, pin } of targets) {
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
            command: msmtpBuildStepCommand(pin, { host: mail.serviceName, port }),
            buildKeyInputs: {
              mailpit: { host: mail.serviceName, port },
              msmtp: msmtpBuildKeyInput(pin),
            },
          });
        }
      }
    }),
};
