#!/usr/bin/env bun
import { main } from "./cli/command";
import { reportCommand } from "./report";

if (process.argv[2] === "report")
  process.exitCode = await reportCommand(process.argv.slice(2));
else await main(process.argv.slice(2));
