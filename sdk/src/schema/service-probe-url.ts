import { Schema } from "effect";

export const ServiceProbeHttpUrl = Schema.String.check(
  Schema.makeFilter((url) => /^https?:\/\/[^/]/iu.test(url) && !/[\s\\]/u.test(url) && URL.canParse(url), {
    message: "Supply an absolute HTTP or HTTPS URL.",
  }),
);
