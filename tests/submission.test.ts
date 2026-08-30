import { describe, expect, it } from "vitest";
import {
  buildSubmissionMessage,
  remainingComposerTextAfterSuccess,
} from "../client/submission.js";

describe("composer submission", () => {
  it("takes control before submitting from a view-only device", () => {
    expect(buildSubmissionMessage({
      id: "message-1",
      text: "继续执行",
    })).toEqual({
      type: "input/submit",
      id: "message-1",
      text: "继续执行",
      takeControl: true,
    });
  });

  it("clears the submitted message after Codex confirms success", () => {
    expect(remainingComposerTextAfterSuccess("继续执行", "继续执行")).toBe("");
  });

  it("keeps a follow-up drafted while the previous message is sending", () => {
    expect(remainingComposerTextAfterSuccess("继续执行下一条", "继续执行")).toBe("下一条");
  });
});
