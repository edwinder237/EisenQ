import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// EisenQ's checks on its copy of Socle's bell (amended design record, point 3):
// its version and Socle commit, the hash check that fails if it's edited here,
// the provider library pinned exactly, and EisenQ's own code never importing a
// provider. The copy's own socle-bell.copy.test.ts, written by Socle, runs too.

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(SRC, "..");
const COPY = join(SRC, "vendor", "socle-bell");

const listed = (dir: string) =>
  readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("  ") as [string, string]);

/** The copy's own check, as a function: the files that no longer match SHA256SUMS. */
function changedFiles(dir: string): string[] {
  return listed(dir)
    .filter(([hash, file]) => createHash("sha256").update(readFileSync(join(dir, file))).digest("hex") !== hash)
    .map(([, file]) => file);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const importsOf = (text: string) =>
  [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g),
    ...text.matchAll(/(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    ...text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g),
  ].map((m) => m[1] ?? "");

describe("the copy of Socle's bell", () => {
  it("names its version and Socle's commit, and the version is the one the bell reports", () => {
    const [version, commit, ...rest] = readFileSync(join(COPY, "VERSION"), "utf8").trim().split(" ");
    expect(rest).toEqual([]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const reported = /export const SOCLE_BELL_VERSION = "([^"]+)";/.exec(readFileSync(join(COPY, "index.ts"), "utf8"))?.[1];
    expect(reported).toBe(version);
  });

  it("matches its SHA256SUMS, which list every file it holds", () => {
    expect(changedFiles(COPY)).toEqual([]);
    const held = readdirSync(COPY).filter((name) => name !== "SHA256SUMS" && name !== "VERSION").sort();
    expect(listed(COPY).map(([, file]) => file).sort()).toEqual(held);
    expect(held).toContain("socle-bell.copy.test.ts");
  });

  it("the check catches an edit made here", () => {
    const dir = mkdtempSync(join(tmpdir(), "socle-bell-"));
    try {
      cpSync(COPY, dir, { recursive: true });
      writeFileSync(join(dir, "SocleBell.tsx"), `${readFileSync(join(dir, "SocleBell.tsx"), "utf8")}\n// a local change`);
      expect(changedFiles(dir)).toEqual(["SocleBell.tsx"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets the provider library at exactly the version its adapter was written for", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const pinned = pkg.dependencies["@novu/js"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/); // exact: no ^ or ~
    expect(readFileSync(join(COPY, "novu-adapter.ts"), "utf8")).toContain(`@novu/js ${pinned}`);
    expect(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8")).toContain(`'@novu/js@${pinned}'`);
  });
});

describe("EisenQ's own code", () => {
  it("never imports a provider library: only the copy's adapter does, inside", () => {
    const providerImports = new Set(
      sourceFiles(SRC).flatMap((path) =>
        importsOf(readFileSync(path, "utf8"))
          .filter((name) => /^@novu\/|^novu$|^resend$|^@resend\//.test(name))
          .map((name) => `${relative(SRC, path)}: ${name}`),
      ),
    );
    expect([...providerImports]).toEqual(["vendor/socle-bell/novu-adapter.ts: @novu/js"]);
  });

  it("shows Socle's bell on the dashboard, in place of the old one", () => {
    const dashboard = readFileSync(join(SRC, "app", "dashboard", "page.tsx"), "utf8");
    expect(importsOf(dashboard)).toContain("~/vendor/socle-bell");
    expect(importsOf(dashboard)).not.toContain("~/components/NotificationBell");
    expect(dashboard).toContain('sessionUrl={notifMode === "live" ? "/api/notifications/bell-session" : null}');
  });
});
