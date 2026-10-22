import { describe, expect, it } from "bun:test";

import { resolveSessionDisplayName } from "../src/extension/index";

const baseInput = {
  role: "participant",
  configuredName: undefined,
  currentName: undefined,
  cwd: "C:/tmp/insta-match",
  sessionId: "01a04b0b-55a0-777a-87b1-34bb67f50837",
};

describe("session display naming", () => {
  for (const role of ["participant", "coordinator"]) {
    it(`keeps an explicit ${role} alias verbatim ahead of the native title`, () => {
      expect(resolveSessionDisplayName({
        ...baseInput,
        role,
        configuredName: "  App Alias  ",
        currentName: "Native Topic",
        titleSource: "auto",
      })).toBe("  App Alias  ");
    });

    it(`names an unnamed ${role} without requiring a native title`, () => {
      expect(resolveSessionDisplayName({ ...baseInput, role })).toBe("insta-match — 01a04b0b");
      expect(resolveSessionDisplayName({ ...baseInput, role, currentName: "", titleSource: "auto" }))
        .toBe("insta-match — 01a04b0b");
    });
  }

  it("preserves user titles, including Participant and legacy folder/id names", () => {
    for (const currentName of ["Participant", "insta-match — 01a04b0b", "  Manual Name  "]) {
      expect(resolveSessionDisplayName({ ...baseInput, currentName, titleSource: "user" })).toBe(currentName);
    }
  });

  it("preserves titles when provenance is missing or unrecognized", () => {
    expect(resolveSessionDisplayName({ ...baseInput, currentName: "Native Topic" })).toBe("Native Topic");
    expect(resolveSessionDisplayName({
      ...baseInput, currentName: "Native Topic", titleSource: "future-source",
    })).toBe("Native Topic");
  });

  it("adds the folder only to confirmed native auto topics", () => {
    expect(resolveSessionDisplayName({
      ...baseInput, currentName: "Repair Notifications", titleSource: "auto",
    })).toBe("insta-match — Repair Notifications");
  });

  it("uses workspace when the path has no folder basename", () => {
    expect(resolveSessionDisplayName({ ...baseInput, cwd: "/" })).toBe("workspace — 01a04b0b");
    expect(resolveSessionDisplayName({
      ...baseInput, cwd: "", currentName: "Repair Notifications", titleSource: "auto",
    })).toBe("workspace — Repair Notifications");
  });

  it("truncates only the generated folder to fit the short-id fallback", () => {
    expect(resolveSessionDisplayName({ ...baseInput, cwd: `C:/tmp/${"f".repeat(250)}` }))
      .toBe(`${"f".repeat(189)} — 01a04b0b`);
  });

  it("does not split a folder surrogate pair at the display limit", () => {
    const cwd = `C:/tmp/${"f".repeat(180)}🚀tail`;
    expect(resolveSessionDisplayName({
      ...baseInput, cwd, currentName: "t".repeat(16), titleSource: "auto",
    })).toBe(`${"f".repeat(180)} — ${"t".repeat(16)}`);
    expect(resolveSessionDisplayName({
      ...baseInput, cwd, currentName: "t".repeat(15), titleSource: "auto",
    })).toBe(`${"f".repeat(180)}🚀 — ${"t".repeat(15)}`);
  });

  it("retains the entire topic at and beyond the generated-label limit", () => {
    expect(resolveSessionDisplayName({
      ...baseInput, currentName: "t".repeat(197), titleSource: "auto",
    })).toBe(` — ${"t".repeat(197)}`);
    const tooLong = resolveSessionDisplayName({
      ...baseInput, currentName: "t".repeat(198), titleSource: "auto",
    });
    expect(tooLong).toBe(` — ${"t".repeat(198)}`);
    expect(tooLong.length).toBe(201);
  });

  it("leaves invalid manual titles and aliases for metadata validation rather than clipping", () => {
    const name = "n".repeat(201);
    expect(resolveSessionDisplayName({ ...baseInput, currentName: name, titleSource: "user" })).toBe(name);
    expect(resolveSessionDisplayName({ ...baseInput, configuredName: name })).toBe(name);
    expect(resolveSessionDisplayName({ ...baseInput, configuredName: "", currentName: "Native Topic" })).toBe("");
  });
});
