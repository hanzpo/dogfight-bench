import { execFileSync } from "node:child_process";
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

  /**
   * The repository is public, so a committed credential is a published one.
   *
   * `.gitignore` is the intent; this is the check. It reads what git actually
   * tracks rather than what is on disk, because the failure being guarded
   * against is exactly a file that should have been ignored and was not.
   *
   * The Supabase project URL and its publishable key are deliberately absent
   * from this list: both are compiled into the browser bundle and served to
   * everyone by design, and row level security is what protects the data.
   */
  it("commits no credential to a public repository", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const shapes: Array<[string, RegExp]> = [
      ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
      ["Supabase service role JWT", /\beyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./],
      ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
      ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
      ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ];

    const offenders: string[] = [];
    for (const path of tracked) {
      if (path.endsWith(".glb") || path.endsWith(".png") || path.endsWith(".blend")) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const [name, shape] of shapes) if (shape.test(text)) offenders.push(`${path}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  /** And nothing that holds one is tracked at all, whatever it contains today. */
  it("tracks no environment file but the template", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    expect(tracked.filter((path) => /(^|\/)\.env/.test(path))).toEqual([".env.example"]);
  });
});
