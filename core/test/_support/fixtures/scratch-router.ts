import { Effect } from "effect";

export default Effect.succeed({
  api: 4,
  type: "compose",
  image: "alpine:3.21",
  appMount: false,
  home: false,
  routes: [],
  endpoints: [],
});
