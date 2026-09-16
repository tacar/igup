import { describe, expect, it } from "vitest";
import { buildMessagePayloads, validatePublishInput } from "./instagram-client.js";
import { emptyMessage } from "./types.js";

describe("validatePublishInput", () => {
  it("accepts a public HTTPS URL and boundary caption", () => {
    expect(() => validatePublishInput("https://example.com/image.jpg", "a".repeat(2_200))).not.toThrow();
  });

  it.each(["", "invalid", "http://example.com/image.jpg"])("rejects invalid URL %s", (url) => {
    expect(() => validatePublishInput(url, "caption")).toThrow();
  });

  it("rejects captions over the Instagram limit", () => {
    expect(() => validatePublishInput("https://example.com/image.jpg", "a".repeat(2_201))).toThrow();
  });
});

describe("buildMessagePayloads", () => {
  it("sends a plain text message when there are no buttons or quick replies", () => {
    const payloads = buildMessagePayloads({ ...emptyMessage(), text: "こんにちは" });
    expect(payloads).toEqual([{ text: "こんにちは" }]);
  });

  it("attaches quick replies to the text message when there are no buttons", () => {
    const payloads = buildMessagePayloads({ ...emptyMessage(), text: "選んでください", quickReplies: [{ title: "はい", payload: "yes" }] });
    expect(payloads).toEqual([{ text: "選んでください", quick_replies: [{ content_type: "text", title: "はい", payload: "yes" }] }]);
  });

  it("carries the message text into a button template, capped at 3 buttons", () => {
    const message = {
      ...emptyMessage(),
      text: "こちらからどうぞ",
      buttons: [
        { type: "web_url" as const, title: "サイトへ", url: "https://example.com" },
        { type: "postback" as const, title: "詳細", payload: "info" },
        { type: "postback" as const, title: "3", payload: "p3" },
        { type: "postback" as const, title: "4番目は入らない", payload: "p4" },
      ],
    };
    const payloads = buildMessagePayloads(message);
    expect(payloads).toHaveLength(1);
    const template = (payloads[0] as { attachment: { payload: { buttons: unknown[]; text: string } } }).attachment.payload;
    expect(template.text).toBe("こちらからどうぞ");
    expect(template.buttons).toHaveLength(3);
  });

  it("follows a button template with a separate quick-reply message using the button prompt", () => {
    const message = {
      ...emptyMessage(),
      text: "こちらからどうぞ",
      buttonPrompt: "次はどうしますか？",
      buttons: [{ type: "postback" as const, title: "詳細", payload: "info" }],
      quickReplies: [{ title: "やめる", payload: "cancel" }],
    };
    const payloads = buildMessagePayloads(message);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual({ text: "次はどうしますか？", quick_replies: [{ content_type: "text", title: "やめる", payload: "cancel" }] });
  });

  it("truncates button titles beyond the 20-character limit", () => {
    const message = { ...emptyMessage(), buttons: [{ type: "postback" as const, title: "a".repeat(30), payload: "p" }] };
    const payloads = buildMessagePayloads(message);
    const template = (payloads[0] as { attachment: { payload: { buttons: { title: string }[] } } }).attachment.payload;
    expect(template.buttons[0]?.title).toBe("a".repeat(20));
  });
});
