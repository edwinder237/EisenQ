// Written by Socle's packages/bell/scripts/vendor.ts. Don't edit it.
// Fails if this copy of Socle's bell was changed here: change it in Socle
// (edwinder237/socle, packages/bell) and copy it again.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dir = fileURLToPath(new URL(".", import.meta.url));
const listed = readFileSync(dir + "SHA256SUMS", "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("  ") as [string, string]);

test("this copy of Socle's bell is exactly the one Socle made", () => {
  for (const [hash, file] of listed) {
    expect(createHash("sha256").update(readFileSync(dir + file)).digest("hex"), file).toBe(hash);
  }
  const files = readdirSync(dir).filter((name) => name !== "SHA256SUMS" && name !== "VERSION").sort();
  expect(files).toEqual(listed.map(([, file]) => file).sort());
});
