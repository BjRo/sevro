#!/usr/bin/env bun
import { main } from "./cli/command";
import { reportCommand } from "./report";
import { informationCommand } from "./cli/help";
import { demoCommand } from "./cli/demo";
import { initCommand } from "./cli/init";

if (informationCommand(process.argv.slice(2))) process.exitCode = 0;
else if (process.argv[2] === "demo") await demoCommand(process.argv.slice(3));
else if (process.argv[2] === "init")
  process.exitCode = await initCommand(process.argv.slice(3));
else if (process.argv[2] === "report")
  process.exitCode = await reportCommand(process.argv.slice(2));
else await main(process.argv.slice(2));
