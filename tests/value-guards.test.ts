import { expect, test } from "bun:test";
import {
  containsControl,
  isRecord,
  requireRecord,
  validQualifiedId,
} from "../src/value-guards";

test.each(["sevro.host", "a.b", "a0.b1-c2", "a.b.c"])(
  "qualified ID accepts %s",
  (value) => {
    expect(validQualifiedId(value)).toBe(true);
  },
);

test.each(
  [
    undefined,
    null,
    1,
    {},
    [],
    "",
    "sevro",
    "A.b",
    "a..b",
    "a.b-",
    "a_b.c",
    "a.b\n",
    "a.é",
  ].map((value) => ({ value })),
)("qualified ID rejects %j", ({ value }) => {
  expect(validQualifiedId(value)).toBe(false);
});

test("control detection rejects every C0 and DEL character but preserves ordinary Unicode", () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127])
    expect(containsControl(`prefix${String.fromCharCode(code)}suffix`)).toBe(
      true,
    );
  expect(containsControl("")).toBe(false);
  expect(containsControl(" space ~ é𝄞")).toBe(false);
});

test.each([null, undefined, [], "text", 0, false].map((value) => ({ value })))(
  "required record rejects %j with its caller's diagnostic",
  ({ value }) => {
    expect(isRecord(value)).toBe(false);
    expect(() => requireRecord(value, "specific malformed record")).toThrow(
      "specific malformed record",
    );
  },
);

test("required record preserves the validated object and its members", () => {
  const value = { id: "a.b", nested: { retained: true } };
  expect(isRecord(value)).toBe(true);
  expect(requireRecord(value, "invalid")).toBe(value);
  expect(requireRecord({}, "invalid")).toEqual({});
});
