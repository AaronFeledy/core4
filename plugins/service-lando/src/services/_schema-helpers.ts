import { Schema } from "effect";

import { ServicePlan } from "@lando/sdk/schema";

export const decodeServicePlan = (input: unknown): typeof ServicePlan.Type =>
  Schema.decodeUnknownSync(ServicePlan)(input);
