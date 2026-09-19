import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  /**
   * Nothing secret leaves in an error message.
   *
   * A provider error relays the upstream response body, which nobody here
   * controls. An endpoint that echoed back the Authorization header it was sent
   * would have handed this server's own key to any anonymous visitor, because
   * the only thing redacted was the caller's own key.
   */
  it("redacts every secret from anything sent to a client", async () => {
    const { redactSecrets } = await import("../server/env");
    // Split so the fixtures are not themselves key-shaped literals in a tracked
    // file, which the scanner above would rightly object to.
    const secrets = [
      "sk-ant-" + "api03-vJ8kQmz2LpXw9TnRb4YcHd6FgA1sE0uZ",
      "sk-proj-" + "7HqN3wZmKt9Rb2VxLc5YpD8sGfA4eJ1uXo",
      "sb_secret_" + "9fK2mQx7Lp4RtZw8Nc3Vb",
      "eyJhbGciOi" + "JIUzI1NiIsInR5cCI6IkpXVCJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36P",
    ];
    for (const secret of secrets) {
      const safe = redactSecrets(`upstream rejected ${secret} loudly`);
      expect(safe).not.toContain(secret);
      expect(safe).toContain("[redacted]");
    }

    // A caller's own key, which is never one of the shapes above.
    expect(redactSecrets("rejected: hunter2-the-caller-key", "hunter2-the-caller-key")).not.toContain("hunter2");
    // Without swallowing the part of the message that says what went wrong.
    expect(redactSecrets("TypeSafe returned HTTP 429: slow down")).toBe("TypeSafe returned HTTP 429: slow down");
  });

  it("tracks no environment file but the template", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    expect(tracked.filter((path) => /(^|\/)\.env/.test(path))).toEqual([".env.example"]);
  });
});
