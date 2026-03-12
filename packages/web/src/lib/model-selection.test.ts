import { describe, expect, it } from "vitest";
import { getHydratedSelectedModel, shouldResetSelectedModel } from "./model-selection";

describe("getHydratedSelectedModel", () => {
  it("keeps the stored model when it is enabled", () => {
    expect(getHydratedSelectedModel(["openai/gpt-5.2", "openai/gpt-5.4"], "openai/gpt-5.4")).toBe(
      "openai/gpt-5.4"
    );
  });

  it("falls back to the first enabled model when the stored model is unavailable", () => {
    expect(
      getHydratedSelectedModel(["openai/gpt-5.2", "openai/gpt-5.4"], "anthropic/claude-sonnet-4-6")
    ).toBe("openai/gpt-5.2");
  });
});

describe("shouldResetSelectedModel", () => {
  it("does not reset before model preferences finish hydrating", () => {
    expect(
      shouldResetSelectedModel(
        ["openai/gpt-5.2", "openai/gpt-5.4"],
        "anthropic/claude-sonnet-4-6",
        false
      )
    ).toBe(false);
  });

  it("resets after hydration when the current model is no longer enabled", () => {
    expect(
      shouldResetSelectedModel(
        ["openai/gpt-5.2", "openai/gpt-5.4"],
        "anthropic/claude-sonnet-4-6",
        true
      )
    ).toBe(true);
  });
});
