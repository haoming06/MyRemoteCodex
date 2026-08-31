import { describe, expect, it } from "vitest";
import {
  alternateLanguage,
  resolveLanguage,
  translate,
  translateServerText,
} from "../client/i18n";

describe("web i18n", () => {
  it("uses a persisted language before the browser language", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("falls back to the browser language", () => {
    expect(resolveLanguage(null, "zh-Hans")).toBe("zh-CN");
    expect(resolveLanguage(null, "en-US")).toBe("en");
  });

  it("switches between the two supported languages", () => {
    expect(alternateLanguage("zh-CN")).toBe("en");
    expect(alternateLanguage("en")).toBe("zh-CN");
  });

  it("translates interpolated UI and server messages", () => {
    expect(translate("petAccessibility", "en", { count: 2, status: "Connected" }))
      .toBe("2 terminals connected, Connected");
    expect(translate("openComposer", "zh-CN")).toBe("打开输入框");
    expect(translate("closeComposer", "en")).toBe("Close message input");
    expect(translateServerText("配对码不正确", "en")).toBe("Incorrect pairing code");
    expect(translateServerText("unknown detail", "en")).toBe("unknown detail");
  });
});
