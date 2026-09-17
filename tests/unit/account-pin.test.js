import { describe, it, expect } from "vitest";

import { parseAccountPin, withAccountPin } from "../../open-sse/utils/modelMarkers.js";
import { reorderByCapabilities } from "../../open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";

const UUID = "3f2a9c1e-4b7d-4e02-9a11-8b7d6c5e4f3a";

describe("account pin parsing", () => {
  it("strips a trailing connection id and returns it", () => {
    expect(parseAccountPin(`cc/claude-opus-4-5@${UUID}`)).toEqual({
      model: "cc/claude-opus-4-5",
      connectionId: UUID,
    });
  });

  it("leaves a plain model untouched", () => {
    expect(parseAccountPin("cc/claude-opus-4-5")).toEqual({
      model: "cc/claude-opus-4-5",
      connectionId: null,
    });
  });

  it("does not treat a non-UUID suffix as a pin", () => {
    // Model ids never contain "@" today; requiring a UUID keeps that safe.
    expect(parseAccountPin("cc/claude@latest")).toEqual({
      model: "cc/claude@latest",
      connectionId: null,
    });
  });

  it("does not throw on non-string input", () => {
    expect(parseAccountPin(null)).toEqual({ model: null, connectionId: null });
    expect(parseAccountPin(undefined)).toEqual({ model: undefined, connectionId: null });
  });

  it("round-trips through withAccountPin", () => {
    const pinned = withAccountPin("cc/claude-opus-4-5", UUID);
    expect(pinned).toBe(`cc/claude-opus-4-5@${UUID}`);
    expect(parseAccountPin(pinned).model).toBe("cc/claude-opus-4-5");
  });

  it("clears an existing pin when given no connection id", () => {
    expect(withAccountPin(`cc/claude-opus-4-5@${UUID}`, null)).toBe("cc/claude-opus-4-5");
    expect(withAccountPin(`cc/claude-opus-4-5@${UUID}`, "")).toBe("cc/claude-opus-4-5");
  });

  it("replaces rather than stacks pins", () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(withAccountPin(`cc/claude-opus-4-5@${UUID}`, other)).toBe(`cc/claude-opus-4-5@${other}`);
  });
});

describe("account pin does not change model identity", () => {
  // A pin is routing metadata; capability tiering must see the bare model id.
  const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];

  it("keeps reorderByCapabilities ordering identical with and without pins", () => {
    const required = new Set(["vision"]);
    const bare = reorderByCapabilities(models, required);
    const pinned = reorderByCapabilities(
      models.map((m) => withAccountPin(m, UUID)),
      required
    );
    expect(pinned.map((m) => parseAccountPin(m).model)).toEqual(bare);
  });

  it("does not crash augmentModelsWithCapacityAdapter on pinned entries", () => {
    // modelSatisfies parsed the raw entry before the fix and threw on the suffix.
    const withPin = [withAccountPin("glm/glm-4.7", UUID)];
    expect(() => augmentModelsWithCapacityAdapter(withPin, new Set(["vision"]), {})).not.toThrow();
  });
});
