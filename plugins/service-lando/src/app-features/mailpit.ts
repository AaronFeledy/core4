import { Effect } from "effect";

import { AppFeatureSelectorMatchedNothingError, MailpitMsmtpBaseFamilyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition, AppFeatureServiceMutators } from "@lando/sdk/services";

import { MAILPIT_SMTP_PORT } from "../mailpit-constants.ts";
import { PHP_FEATURE_ID } from "../services/php-feature.ts";
import {
  type MsmtpFamilyPin,
  msmtpBuildKeyInput,
  msmtpBuildStepCommand,
  msmtpPinFor,
} from "../services/php-msmtp.ts";
import { readPhpRuntimePolicy } from "../services/php-runtime-policy.ts";

export const mailpitWireFeature: AppFeatureDefinition = {
  id: "service-lando.mailpit.wire",
  priority: 100,
  activatedBy: { services: { type: "mailpit" } },
  selectors: { types: ["mailpit"], hasFeature: [PHP_FEATURE_ID] },
  apply: Effect.fn("MailpitWireFeature.apply")(function* (ctx) {
    const php = new Map(
      ctx.selected
        .filter((service) => service.featureIds.includes(PHP_FEATURE_ID))
        .map((service) => [service.serviceName, service]),
    );
    const pins = new Map<string, MsmtpFamilyPin>();
    const unknownTarget = (mailName: string, target: string) =>
      new AppFeatureSelectorMatchedNothingError({
        message: `Mailpit service ${mailName} mailFrom target ${target} is not a resolved PHP service.`,
        feature: ctx.featureId,
        remediation:
          "Choose existing PHP service names in mailFrom, omit it for all PHP services, or set it to false.",
      });
    const wiring: Array<{
      readonly mail: (typeof ctx.selected)[number];
      readonly targets: ReadonlyArray<{
        readonly service: AppFeatureServiceMutators;
        readonly pin: MsmtpFamilyPin;
      }>;
    }> = [];
    for (const mail of ctx.selected.filter((service) => service.serviceType === "mailpit")) {
      const authored = mail.normalizedConfig.mailFrom;
      const names = authored === false ? [] : (authored ?? [...php.keys()]);
      const targets = [];
      for (const name of names) {
        const sender = php.get(name);
        if (sender === undefined) {
          return yield* Effect.fail(unknownTarget(mail.serviceName, name));
        }
        let pin = pins.get(name);
        if (pin === undefined) {
          const policy = yield* readPhpRuntimePolicy(sender, ctx.featureId);
          const family = policy.baseFamily;
          switch (family.kind) {
            case "unknown": {
              const exclusion = `Leave ${name} out of mailFrom by listing other services, or set mailFrom: false.`;
              return yield* Effect.fail(
                new MailpitMsmtpBaseFamilyError({
                  feature: ctx.featureId,
                  service: name,
                  reason: family.reason,
                  ...(policy.reference === undefined ? {} : { image: policy.reference }),
                  message:
                    family.reason === "replacement-build"
                      ? `Mailpit cannot pin msmtp for PHP service ${name}: the replacement Dockerfile result voids base-family proof from an image reference.`
                      : `Mailpit cannot pin msmtp for PHP service ${name}: image ${policy.reference ?? "(none)"} proves no supported base image family.`,
                  remediation:
                    family.reason === "replacement-build"
                      ? `Use a known image without a replacement build. ${exclusion}`
                      : `Use a canonical php:<version>-<via>-bookworm (debian-bookworm) or php:<version>-<via>-bullseye (debian-bullseye) reference. ${exclusion}`,
                }),
              );
            }
            case "known":
              pin = msmtpPinFor(family.family);
              pins.set(name, pin);
              break;
            default:
              return family satisfies never;
          }
        }
        const service = ctx.select(name);
        if (service === undefined) return yield* Effect.fail(unknownTarget(mail.serviceName, name));
        targets.push({ service, pin });
      }
      wiring.push({ mail, targets });
    }
    for (const { mail, targets } of wiring) {
      const port = mail.normalizedConfig.port ?? MAILPIT_SMTP_PORT;
      for (const { service, pin } of targets) {
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
