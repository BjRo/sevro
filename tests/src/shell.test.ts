import { expect, test } from "bun:test";
import fc from "fast-check";
import { shellQuote } from "../../src/shell";

async function roundTrip(value: string): Promise<void> {
  const proc = Bun.spawn(
    ["/bin/sh", "-c", `printf '%s' ${shellQuote(value)}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [bytes, error, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(Buffer.from(bytes)).toEqual(Buffer.from(value, "utf8"));
}

test.each([
  "",
  "a'b\"c\\d",
  " spaces\tand\nnewlines ",
  "$(printf injected); `printf injected` $HOME * ? [a-z] > /dev/null",
  "é𝄞",
])("shell quoting preserves a literal argument %j", roundTrip);

test("shell quoting round trips generated arguments through a real POSIX shell", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string().filter((value) => !value.includes("\0")),
      roundTrip,
    ),
    { seed: 20261007, numRuns: 200, endOnFailure: true },
  );
});
