#!/usr/bin/env node
import {
  main,
  informationCommand,
  demoCommand,
  initCommand,
} from "./cli/index";
import { reportCommand, pruneCommand } from "./results/index";

if (informationCommand(process.argv.slice(2))) process.exitCode = 0;
else if (process.argv[2] === "demo") await demoCommand(process.argv.slice(3));
else if (process.argv[2] === "init")
  process.exitCode = await initCommand(process.argv.slice(3));
else if (process.argv[2] === "report")
  process.exitCode = await reportCommand(process.argv.slice(2));
else if (process.argv[2] === "prune")
  process.exitCode = await pruneCommand(process.argv.slice(3));
else await main(process.argv.slice(2));
