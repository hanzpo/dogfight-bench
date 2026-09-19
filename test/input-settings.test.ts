import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../src/ui/input/pilot-input";

/**
 * Whatever is in storage was written by some build of this page, not
 * necessarily this one. A stored setting of the wrong type or a silly
 * magnitude would survive a release and quietly break the controls, with
 * nothing to do about it but know to clear the site's data.
 */
describe("remembered control settings", () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const write = (raw: string) => stored.set("dogfight.input", raw);

  it.each([
    ["nothing stored", undefined],
    ["a value that is not JSON", "garbage"],
    ["a stored null", "null"],
    ["a setting of the wrong type", '{"mousePixelsForFullDeflection":"banana"}'],
    ["a boolean that is a string", '{"invertMousePitch":"yes"}'],
  ])("falls back to the defaults for %s", (_name, raw) => {
    if (raw !== undefined) write(raw);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("bounds a setting that would make the controls unusable", () => {
    write('{"mousePixelsForFullDeflection":0,"gamepadDeadzone":99}');
    const settings = loadSettings();
    expect(settings.mousePixelsForFullDeflection).toBeGreaterThan(0);
    expect(settings.gamepadDeadzone).toBeLessThan(1);
  });

  it("keeps what somebody actually chose", () => {
    write('{"mousePixelsForFullDeflection":200,"invertMousePitch":true}');
    expect(loadSettings()).toMatchObject({ mousePixelsForFullDeflection: 200, invertMousePitch: true });
  });

  it("throws nothing when storage itself is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked in private browsing");
      },
    });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
