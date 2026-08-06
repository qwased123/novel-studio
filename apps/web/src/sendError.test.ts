import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { formatSendFailure } from "./sendError";

describe("formatSendFailure", () => {
  it("shows the structured server/provider cause when the user message was saved", () => {
    const error = new ApiError("模型返回了具体错误", 502, "model_request_failed");
    expect(formatSendFailure(error, true)).toBe("消息已保存，但发送失败：模型返回了具体错误");
  });

  it("reserves the response-lost wording for genuine non-API failures", () => {
    expect(formatSendFailure(new TypeError("Failed to fetch"), true)).toBe("消息已保存，但未收到回复。请检查会话后继续。");
  });

  it("shows the raw error when nothing was persisted", () => {
    expect(formatSendFailure(new Error("网络中断"), false)).toBe("网络中断");
    expect(formatSendFailure("unknown", false)).toBe("发送失败，请重试");
  });
});
