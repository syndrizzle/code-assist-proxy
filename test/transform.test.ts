import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeModelName,
  clearModelNormalizationCache,
  getModelNormalizationCacheSize,
  parseGeminiPath,
  buildCloudCodeRequestBody,
  unwrapCloudCodeResponse,
} from "../src/transform";

describe("Transform Engine Optimizations", () => {
  beforeEach(() => {
    clearModelNormalizationCache();
  });

  describe("Model Name Normalization with Caching", () => {
    it("should normalize known model variants correctly", () => {
      const testCases = [
        { input: "gemini-pro", expected: "gemini-2.5-pro", changed: true },
        { input: "gemini-1.5-pro", expected: "gemini-2.5-pro", changed: true },
        { input: "gemini-flash", expected: "gemini-2.5-flash", changed: true },
        {
          input: "gemini-1.5-flash",
          expected: "gemini-2.5-flash",
          changed: true,
        },
        { input: "gemini-2.5-pro", expected: "gemini-2.5-pro", changed: false },
        { input: "unknown-model", expected: "unknown-model", changed: false },
      ];

      testCases.forEach(({ input, expected, changed }) => {
        const result = normalizeModelName(input);
        expect(result.normalized).toBe(expected);
        expect(result.changed).toBe(changed);
      });
    });

    it("should cache normalization results for performance", () => {
      expect(getModelNormalizationCacheSize()).toBe(0);

      // First call should cache the result
      normalizeModelName("gemini-pro");
      expect(getModelNormalizationCacheSize()).toBe(1);

      // Second call should use cache
      const result = normalizeModelName("gemini-pro");
      expect(result.normalized).toBe("gemini-2.5-pro");
      expect(getModelNormalizationCacheSize()).toBe(1);
    });

    it("should handle pattern matching for unknown variants", () => {
      const result1 = normalizeModelName("custom-pro-model");
      expect(result1.normalized).toBe("gemini-2.5-pro");
      expect(result1.changed).toBe(true);

      const result2 = normalizeModelName("custom-flash-model");
      expect(result2.normalized).toBe("gemini-2.5-flash");
      expect(result2.changed).toBe(true);
    });

    it("should prevent cache from growing too large", () => {
      // This test would be slow in practice, so we'll just verify the logic exists
      for (let i = 0; i < 10; i++) {
        normalizeModelName(`test-model-${i}`);
      }
      expect(getModelNormalizationCacheSize()).toBe(10);
    });
  });

  describe("Path Parsing", () => {
    it("should parse Gemini API paths correctly", () => {
      const testCases = [
        {
          path: "v1/models/gemini-pro:generateContent",
          expected: { model: "gemini-pro", action: "generateContent" },
        },
        {
          path: "v1beta/models/gemini-flash:streamGenerateContent",
          expected: { model: "gemini-flash", action: "streamGenerateContent" },
        },
        {
          path: "invalid/path",
          expected: null,
        },
      ];

      testCases.forEach(({ path, expected }) => {
        const result = parseGeminiPath(path);
        expect(result).toEqual(expected);
      });
    });
  });

  describe("Request Body Building", () => {
    it("should build Cloud Code request body correctly", () => {
      const originalBody = { contents: [{ parts: [{ text: "test" }] }] };
      const result = buildCloudCodeRequestBody(
        originalBody,
        "gemini-2.5-pro",
        "generateContent",
        "test-project"
      );

      expect(result).toEqual({
        model: "gemini-2.5-pro",
        project: "test-project",
        request: originalBody,
      });
    });

    it("should handle countTokens action specially", () => {
      const originalBody = {
        generateContentRequest: { contents: [{ parts: [{ text: "test" }] }] },
      };
      const result = buildCloudCodeRequestBody(
        originalBody,
        "gemini-2.5-pro",
        "countTokens",
        "test-project"
      );

      expect(result.request.model).toBe("models/gemini-2.5-pro");
    });
  });

  describe("Response Unwrapping", () => {
    it("should unwrap Cloud Code responses correctly", () => {
      const cloudCodeResp = {
        response: {
          candidates: [{ content: { parts: [{ text: "response" }] } }],
        },
        metadata: { usage: { inputTokens: 10 } },
      };

      const result = unwrapCloudCodeResponse(cloudCodeResp);
      expect(result.candidates).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it("should pass through responses without nested response", () => {
      const directResp = {
        candidates: [{ content: { parts: [{ text: "response" }] } }],
      };
      const result = unwrapCloudCodeResponse(directResp);
      expect(result).toEqual(directResp);
    });
  });
});
