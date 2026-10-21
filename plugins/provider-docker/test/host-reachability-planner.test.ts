import { expect, test } from "bun:test";
import { dockerCapabilitiesForHost } from "@lando/provider-docker";
import { Effect } from "effect";
import { authoredExtraHosts, hostProbeService, planHostProbe } from "./host-reachability-fixture.ts";

test("plans authored extra_hosts with Docker capabilities without post-plan extension injection", async () => {
  // Given: actual Docker capabilities and authored conflicting/multi-address hosts.
  const capabilities = dockerCapabilitiesForHost("linux", "/var/run/docker.sock");
  // When: the real planner contributes and validates the authored Compose knob.
  const plan = await Effect.runPromise(planHostProbe("host-planner-regression", capabilities));
  // Then: the authored values reach the provider input unchanged.
  expect(plan.services[hostProbeService]?.extensions.compose).toEqual({ extra_hosts: authoredExtraHosts });
  expect(capabilities.composeKnobs).toEqual({
    supported: [
      "restart",
      "cap_add",
      "cap_drop",
      "privileged",
      "devices",
      "ulimits",
      "sysctls",
      "tmpfs",
      "shm_size",
      "dns",
      "dns_search",
      "dns_opt",
      "extra_hosts",
      "init",
      "stop_signal",
      "stop_grace_period",
      "security_opt",
      "group_add",
      "read_only",
      "platform",
      "logging",
    ],
  });
});
