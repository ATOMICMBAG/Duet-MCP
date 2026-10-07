import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);
const json = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

describe("packaging metadata", () => {
  it("uses one version everywhere", async () => {
    const pkg = json("package.json");
    expect(json("manifest.json").version).toBe(pkg.version);
    expect(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")).toContain(`[${pkg.version}]`);
    const { client } = await bootServer({ readOnly: true });
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  }, 25000);

  it("is MIT licensed and ships the safety documents", () => {
    const pkg = json("package.json");
    expect(pkg.license).toBe("MIT");
    for (const f of ["LICENSE", "SAFETY.md", "SAFETY_RULES.md", "README.md"]) expect(pkg.files).toContain(f);
    expect(json("manifest.json").license).toBe("MIT");
  });
});
