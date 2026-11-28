import { describe, expect, test } from "bun:test";
import { EFFORT_POLICY, isPassthrough, resolveEffort, targetEffort } from "./effort.mjs";

describe("effort passthrough", () => {
  test("hands the client's own level through", () => {
    expect(targetEffort(EFFORT_POLICY.PASSTHROUGH, "xhigh")).toBe("xhigh");
    expect(isPassthrough(EFFORT_POLICY.PASSTHROUGH)).toBe(true);
  });

  test("does not invent a level the client never asked for", () => {
    expect(targetEffort(EFFORT_POLICY.PASSTHROUGH, undefined)).toBeUndefined();
    expect(
      resolveEffort({
        policy: EFFORT_POLICY.PASSTHROUGH,
        requested: undefined,
        traits: { reasoning: true, efforts: ["low", "medium"] },
      }),
    ).toBeUndefined();
  });

  test("does not fit the level down to the model's list", () => {
    expect(
      resolveEffort({
        policy: EFFORT_POLICY.PASSTHROUGH,
        requested: "max",
        traits: { reasoning: true, efforts: ["low", "medium"] },
      }),
    ).toBe("max");
  });

  test("leaves the fixed and capped policies as they were", () => {
    expect(resolveEffort({ policy: EFFORT_POLICY.CAPPED, requested: "max", traits: undefined })).toBe("medium");
    expect(resolveEffort({ policy: "high", requested: "low", traits: undefined })).toBe("high");
    expect(isPassthrough("capped")).toBe(false);
  });
});
