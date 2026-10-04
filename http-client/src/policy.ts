import { Context } from "effect";

/** Lando egress policy, scoped to the requesting fiber rather than the client layer. */
export interface RequestPolicyShape {
  readonly callerId?: string;
  readonly onBehalfOf?: string;
  readonly redactionTokens?: readonly string[];
  readonly allowFileSource?: boolean;
  readonly offline?: boolean;
  readonly redirect?: "follow" | "manual" | "error";
}

export const RequestPolicy = Context.Reference<RequestPolicyShape>("@lando/http-client/RequestPolicy", {
  defaultValue: () => ({}),
});
