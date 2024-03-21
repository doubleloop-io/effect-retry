import * as F from "effect/Function";
import * as Console from "effect/Console";
import {NodeRuntime} from "@effect/platform-node"

F.pipe(
  Console.log("Hello, World!"),
  NodeRuntime.runMain,
);
