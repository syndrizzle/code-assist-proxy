import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateConfiguration,
  formatConfigurationErrors,
  logConfigurationStatus,
  createFeatureFlags,
  FeatureFlagManager,
  type ConfigValidationError,
  type ValidatedConfig,
  type FeatureFlags,
} from "../src/config";
import { Env } from "../src/types";

// Mock KVNamespace for testing
interface MockKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: any): Promise<any>;
}

describe("Configuration Validation", () => {
  const mockKV = {} as MockKVNamespace;

  const validEnv: Env = {
    GCP_SERVICE_ACCOUNT: '{"type": "service_account", "project_id": "test"}',
    GEMINI_PROJECT_ID: "test-project",
    GEMINI_CREDS_KV: mockKV,
  };

  describe("validateConfiguration", () => {
    it("should validate required fields", () => {
      const invalidEnv = {} as Env;
      const { errors } = validateConfiguration(invalidEnv);

      expect(errors).toHaveLength(2);
      expect(errors[0].field).toBe("GCP_SERVICE_ACCOUNT");
      expect(errors[1].field).toBe("GEMINI_CREDS_KV");
    });

    it("should validate GCP_SERVICE_ACCOUNT JSON format", () => {
      const invalidEnv: Env = {
        GCP_SERVICE_ACCOUNT: "invalid-json",
        GEMINI_CREDS_KV: mockKV,
      };

      const { errors } = validateConfiguration(invalidEnv);

      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("GCP_SERVICE_ACCOUNT");
      expect(errors[0].message).toContain("valid JSON");
    });

    it("should use default values for optional configuration", () => {
      const { config, errors } = validateConfiguration(validEnv);

      expect(errors).toHaveLength(0);
      expect(config.enableConnectionPooling).toBe(true);
      expect(config.tokenRefreshBufferMinutes).toBe(5);
      expect(config.maxConcurrentRequests).toBe(100);
      expect(config.enableRequestDeduplication).toBe(false);
      expect(config.cacheProjectIdTtlHours).toBe(1);
      expect(config.enableCircuitBreaker).toBe(true);
      expect(config.circuitBreakerThreshold).toBe(5);
      expect(config.circuitBreakerTimeoutMs).toBe(60000);
    });

    it("should parse boolean values correctly", () => {
      const envWithBooleans: Env = {
        ...validEnv,
        ENABLE_CONNECTION_POOLING: "false",
        ENABLE_REQUEST_DEDUPLICATION: "1",
        ENABLE_CIRCUIT_BREAKER: "yes",
      };

      const { config, errors } = validateConfiguration(envWithBooleans);

      expect(errors).toHaveLength(0);
      expect(config.enableConnectionPooling).toBe(false);
      expect(config.enableRequestDeduplication).toBe(true);
      expect(config.enableCircuitBreaker).toBe(true);
    });

    it("should handle invalid boolean values", () => {
      const envWithInvalidBooleans: Env = {
        ...validEnv,
        ENABLE_CONNECTION_POOLING: "maybe",
      };

      const { config, errors } = validateConfiguration(envWithInvalidBooleans);

      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("ENABLE_CONNECTION_POOLING");
      expect(config.enableConnectionPooling).toBe(true); // Should use default
    });

    it("should validate numeric ranges", () => {
      const envWithInvalidNumbers: Env = {
        ...validEnv,
        TOKEN_REFRESH_BUFFER_MINUTES: "0", // Below minimum
        MAX_CONCURRENT_REQUESTS: "2000", // Above maximum
        CIRCUIT_BREAKER_THRESHOLD: "not-a-number",
      };

      const { config, errors } = validateConfiguration(envWithInvalidNumbers);

      expect(errors).toHaveLength(3);
      expect(errors[0].field).toBe("TOKEN_REFRESH_BUFFER_MINUTES");
      expect(errors[1].field).toBe("MAX_CONCURRENT_REQUESTS");
      expect(errors[2].field).toBe("CIRCUIT_BREAKER_THRESHOLD");

      // Should use defaults for invalid values
      expect(config.tokenRefreshBufferMinutes).toBe(5);
      expect(config.maxConcurrentRequests).toBe(100);
      expect(config.circuitBreakerThreshold).toBe(5);
    });

    it("should accept valid numeric values", () => {
      const envWithValidNumbers: Env = {
        ...validEnv,
        TOKEN_REFRESH_BUFFER_MINUTES: "10",
        MAX_CONCURRENT_REQUESTS: "50",
        CACHE_PROJECT_ID_TTL_HOURS: "2.5",
        CIRCUIT_BREAKER_THRESHOLD: "3",
        CIRCUIT_BREAKER_TIMEOUT_MS: "30000",
      };

      const { config, errors } = validateConfiguration(envWithValidNumbers);

      expect(errors).toHaveLength(0);
      expect(config.tokenRefreshBufferMinutes).toBe(10);
      expect(config.maxConcurrentRequests).toBe(50);
      expect(config.cacheProjectIdTtlHours).toBe(2.5);
      expect(config.circuitBreakerThreshold).toBe(3);
      expect(config.circuitBreakerTimeoutMs).toBe(30000);
    });
  });

  describe("formatConfigurationErrors", () => {
    it("should return empty string for no errors", () => {
      const result = formatConfigurationErrors([]);
      expect(result).toBe("");
    });

    it("should format single error correctly", () => {
      const errors: ConfigValidationError[] = [
        {
          field: "TEST_FIELD",
          value: "invalid",
          message: "Test error message",
          suggestion: "Test suggestion",
        },
      ];

      const result = formatConfigurationErrors(errors);

      expect(result).toContain("❌ TEST_FIELD: Test error message");
      expect(result).toContain("💡 Suggestion: Test suggestion");
    });

    it("should format multiple errors correctly", () => {
      const errors: ConfigValidationError[] = [
        {
          field: "FIELD1",
          value: "invalid1",
          message: "Error 1",
        },
        {
          field: "FIELD2",
          value: "invalid2",
          message: "Error 2",
          suggestion: "Suggestion 2",
        },
      ];

      const result = formatConfigurationErrors(errors);

      expect(result).toContain("❌ FIELD1: Error 1");
      expect(result).toContain("❌ FIELD2: Error 2");
      expect(result).toContain("💡 Suggestion: Suggestion 2");
    });
  });

  describe("logConfigurationStatus", () => {
    it("should log configuration without errors", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const config: ValidatedConfig = {
        enableConnectionPooling: true,
        tokenRefreshBufferMinutes: 5,
        maxConcurrentRequests: 100,
        enableRequestDeduplication: false,
        cacheProjectIdTtlHours: 1,
        enableCircuitBreaker: true,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeoutMs: 60000,
      };

      logConfigurationStatus(config, []);

      expect(consoleSpy).toHaveBeenCalledWith("🔧 Configuration Status:");
      expect(consoleSpy).toHaveBeenCalledWith("📋 Active Configuration:");
      expect(consoleSpy).toHaveBeenCalledWith("   Connection Pooling: ✅");
      expect(consoleSpy).toHaveBeenCalledWith("   Circuit Breaker: ✅");
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it("should log configuration with errors", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const config: ValidatedConfig = {
        enableConnectionPooling: false,
        tokenRefreshBufferMinutes: 5,
        maxConcurrentRequests: 100,
        enableRequestDeduplication: false,
        cacheProjectIdTtlHours: 1,
        enableCircuitBreaker: false,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeoutMs: 60000,
      };

      const errors: ConfigValidationError[] = [
        {
          field: "TEST_FIELD",
          value: "invalid",
          message: "Test error",
        },
      ];

      logConfigurationStatus(config, errors);

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("   Connection Pooling: ❌");
      expect(consoleSpy).toHaveBeenCalledWith("   Circuit Breaker: ❌");

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("Feature Flags", () => {
    const mockKV = {} as MockKVNamespace;
    const validEnv: Env = {
      GCP_SERVICE_ACCOUNT: '{"type": "service_account", "project_id": "test"}',
      GEMINI_PROJECT_ID: "test-project",
      GEMINI_CREDS_KV: mockKV,
    };

    describe("createFeatureFlags", () => {
      it("should create feature flags with default values", () => {
        const { config } = validateConfiguration(validEnv);
        const flags = createFeatureFlags(config, validEnv);

        expect(flags.connectionPooling.enabled).toBe(true);
        expect(flags.connectionPooling.strategy).toBe("adaptive");
        expect(flags.connectionPooling.maxConnections).toBe(10);

        expect(flags.caching.tokenCaching).toBe(true);
        expect(flags.caching.projectIdCaching).toBe(true);
        expect(flags.caching.strategy).toBe("hybrid");

        expect(flags.retry.enabled).toBe(true);
        expect(flags.retry.strategy).toBe("exponential");
        expect(flags.retry.maxAttempts).toBe(3);

        expect(flags.streaming.optimizedParsing).toBe(true);
        expect(flags.streaming.zeroCopyEnabled).toBe(true);

        expect(flags.monitoring.metricsEnabled).toBe(true);
        expect(flags.monitoring.performanceTracking).toBe(true);
      });

      it("should respect environment variable overrides", () => {
        const envWithOverrides: Env = {
          ...validEnv,
          CONNECTION_POOLING_STRATEGY: "http2",
          MAX_CONNECTIONS: "20",
          CACHING_STRATEGY: "memory",
          RETRY_STRATEGY: "linear",
          ENABLE_COMPRESSION: "true",
        };

        const { config } = validateConfiguration(envWithOverrides);
        const flags = createFeatureFlags(config, envWithOverrides);

        expect(flags.connectionPooling.strategy).toBe("http2");
        expect(flags.connectionPooling.maxConnections).toBe(20);
        expect(flags.caching.strategy).toBe("memory");
        expect(flags.retry.strategy).toBe("linear");
        expect(flags.streaming.compressionEnabled).toBe(true);
      });
    });
  });

  describe("FeatureFlagManager", () => {
    let manager: FeatureFlagManager;
    let mockFlags: FeatureFlags;

    beforeEach(() => {
      mockFlags = {
        connectionPooling: {
          enabled: true,
          strategy: "adaptive",
          maxConnections: 10,
          keepAliveTimeout: 60000,
        },
        caching: {
          tokenCaching: true,
          projectIdCaching: true,
          modelNameCaching: true,
          strategy: "hybrid",
          ttlMultiplier: 1.0,
        },
        retry: {
          enabled: true,
          strategy: "exponential",
          maxAttempts: 3,
          baseDelayMs: 1000,
          jitterEnabled: true,
        },
        streaming: {
          optimizedParsing: true,
          zeroCopyEnabled: true,
          bufferSize: 8192,
          compressionEnabled: false,
        },
        monitoring: {
          metricsEnabled: true,
          detailedLogging: false,
          performanceTracking: true,
          errorTracking: true,
        },
      };

      manager = new FeatureFlagManager(mockFlags);
    });

    it("should get flag values correctly", () => {
      expect(manager.getFlag("connectionPooling", "enabled")).toBe(true);
      expect(manager.getFlag("retry", "maxAttempts")).toBe(3);
      expect(manager.getFlag("streaming")).toEqual(mockFlags.streaming);
    });

    it("should set flag overrides", () => {
      manager.setFlag("connectionPooling", "maxConnections", 20);

      expect(manager.getFlag("connectionPooling", "maxConnections")).toBe(20);
      expect(manager.getFlag("connectionPooling", "enabled")).toBe(true); // Other flags unchanged
    });

    it("should notify listeners on flag changes", () => {
      const listener = vi.fn();
      manager.subscribe("retry", "maxAttempts", listener);

      manager.setFlag("retry", "maxAttempts", 5);

      expect(listener).toHaveBeenCalledWith(5);
    });

    it("should support category-level listeners", () => {
      const listener = vi.fn();
      manager.subscribe("caching", listener);

      manager.setFlag("caching", "ttlMultiplier", 2.0);

      expect(listener).toHaveBeenCalledWith(2.0);
    });

    it("should return unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = manager.subscribe(
        "monitoring",
        "metricsEnabled",
        listener
      );

      manager.setFlag("monitoring", "metricsEnabled", false);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      manager.setFlag("monitoring", "metricsEnabled", true);
      expect(listener).toHaveBeenCalledTimes(1); // Should not be called again
    });

    it("should clear all overrides", () => {
      manager.setFlag("connectionPooling", "maxConnections", 20);
      manager.setFlag("retry", "maxAttempts", 5);

      expect(manager.getFlag("connectionPooling", "maxConnections")).toBe(20);
      expect(manager.getFlag("retry", "maxAttempts")).toBe(5);

      manager.clearOverrides();

      expect(manager.getFlag("connectionPooling", "maxConnections")).toBe(10);
      expect(manager.getFlag("retry", "maxAttempts")).toBe(3);
    });

    it("should provide configuration summary", () => {
      manager.setFlag("streaming", "bufferSize", 16384);

      const summary = manager.getConfigSummary();

      expect(summary.streaming.bufferSize.value).toBe(16384);
      expect(summary.streaming.bufferSize.overridden).toBe(true);
      expect(summary.streaming.optimizedParsing.value).toBe(true);
      expect(summary.streaming.optimizedParsing.overridden).toBe(false);
    });

    it("should log status correctly", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      manager.setFlag("monitoring", "detailedLogging", true);
      manager.logStatus();

      expect(consoleSpy).toHaveBeenCalledWith("🚩 Feature Flags Status:");
      expect(consoleSpy).toHaveBeenCalledWith("   Active overrides: 1");

      consoleSpy.mockRestore();
    });
  });
});
