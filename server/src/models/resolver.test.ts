import { describe, it, expect } from "vitest";
import { pickByPreference } from "./resolver.js";

const GB = 1024 ** 3;
const files = [
  { path: "flux1-dev-Q2_K.gguf", size: 4.0 * GB }, { path: "flux1-dev-Q3_K_S.gguf", size: 5.2 * GB }, { path: "flux1-dev-Q4_0.gguf", size: 6.8 * GB },
  { path: "flux1-dev-Q4_K_S.gguf", size: 6.8 * GB }, { path: "flux1-dev-Q5_K_S.gguf", size: 8.3 * GB }, { path: "flux1-dev-Q8_0.gguf", size: 12.7 * GB }, { path: "flux1-dev-F16.gguf", size: 23.8 * GB },
];
const prefer = ["Q4_K_S", "Q4_0", "Q5_K_S", "Q8_0", "Q3_K_S", "F16"];

describe("pickByPreference", () => {
  it("picks the first preferred quant that fits the budget", () => {
    expect(pickByPreference(files, prefer, 7 * GB)).toMatchObject({ path: "flux1-dev-Q4_K_S.gguf", fits: true });
    expect(pickByPreference(files, prefer, 13 * GB)).toMatchObject({ path: "flux1-dev-Q4_K_S.gguf" }); // preference order wins over "biggest that fits"
    expect(pickByPreference(files, ["Q8_0", "Q4_K_S"], 13 * GB)).toMatchObject({ path: "flux1-dev-Q8_0.gguf" });
  });
  it("falls back to the smallest file when nothing fits, flagged as not fitting", () => {
    expect(pickByPreference(files, prefer, 3 * GB)).toMatchObject({ path: "flux1-dev-Q2_K.gguf", fits: false });
  });
  it("honours an explicit quant override", () => {
    expect(pickByPreference(files, prefer, 7 * GB, "q8_0")).toMatchObject({ path: "flux1-dev-Q8_0.gguf", fits: false });
  });
  it("returns null for empty input", () => { expect(pickByPreference([], prefer, GB)).toBeNull(); });
});
