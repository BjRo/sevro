import { writeFileSync } from "node:fs";
const mode = process.argv[2];
const marker = process.argv[3];
if (marker) writeFileSync(marker, String(process.pid));
if (mode === "failure") process.exit(1);
if (mode === "slow")
  setInterval(() => {
    process.stdout.write("");
  }, 1000);
else if (mode === "oversized")
  process.stdout.write(Buffer.alloc(1024 * 1024 + 1, "x"));
else if (mode === "whitespace") process.stdout.write(" \n\t");
else if (mode !== "empty")
  process.stdout.write('{"login":"PRIVATE_TEST_LOGIN"}');
