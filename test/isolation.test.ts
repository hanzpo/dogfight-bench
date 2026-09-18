import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The browser bundle must never be able to reach a provider credential.
 *
 * This is the one property of the architecture that cannot be checked by
 * reading the code once and trusting it afterwards: a single stray import in
 * `src/` would ship an API key to every visitor. So it is a test.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("credential isolation", () => {
  it("never imports server code from the browser bundle", () => {
    const offenders = sourceFiles("src").filter((path) => {
      const text = readFileSync(path, "utf8");
      return /from\s+["'][^"']*\/server\//.test(text) || /from\s+["']\.\.\/\.\.\/server/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("never references a provider credential from the browser bundle", () => {
    const secrets = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TYPESAFE_API_KEY", "process.env"];
    const offenders = sourceFiles("src").filter((path) => {
      const text = readFileSync(path, "utf8");
      return secrets.some((secret) => text.includes(secret));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps provider SDKs out of the browser bundle", () => {
    const offenders = sourceFiles("src").filter((path) =>
      /from\s+["']@anthropic-ai\//.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
