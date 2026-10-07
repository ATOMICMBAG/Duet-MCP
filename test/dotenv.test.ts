import { describe, expect, it } from "vitest";
import { loadDotEnv, parseDotEnv } from "../src/config.js";

describe("parseDotEnv", () => {
  it("parses keys, quotes and comments", () => {
    expect(parseDotEnv('# c\nA=1\nB = "two words"\nC=\'x\'\n  D=y  \nbad line')).toEqual({ A: "1", B: "two words", C: "x", D: "y" });
  });
});

describe("loadDotEnv", () => {
  it("does not overwrite existing variables and tolerates a missing file", () => {
    const env: Record<string, string | undefined> = { DUET_HOST: "already" };
    loadDotEnv(new URL("file:///does/not/exist/.env"), env);
    expect(env).toEqual({ DUET_HOST: "already" });
  });
});
