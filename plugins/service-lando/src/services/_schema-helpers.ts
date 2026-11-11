import { ServicePlan } from "@lando/sdk/schema";
import { Schema } from "effect";

export const decodeServicePlan = (input: unknown): typeof ServicePlan.Type =>
  Schema.decodeUnknownSync(ServicePlan)(input);
