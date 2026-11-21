import { expect, test } from "bun:test";
import { ServiceLaunchers } from "@lando/sdk/services";
import { Schema } from "effect";
import { rubyServiceLaunchers } from "../src/services/ruby-local-launcher.ts";

test(":ruby-local is a valid launcher that runs its probe through ruby -e before --", () => {
  expect(Schema.is(ServiceLaunchers)(rubyServiceLaunchers)).toBe(true);
  expect(rubyServiceLaunchers[":ruby-local"]).toEqual(["ruby", "-e", expect.any(String), "--"]);
});
