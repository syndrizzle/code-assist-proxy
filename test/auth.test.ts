import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuthManager } from "../src/auth";
import { Env, CachedTokenData } from "../src/types";

// Mock KV namespace for testing with enhanced functionality
class MockKVNamespace {
  private storage = new Map<string, { value: string; ttl?: number; timestamp: number }>();

  async get<T>(key: string, type?: string): Promise<T | null> {
    const entry = this.storage.get(key);
    if (!entry) return null;

    // Check TTL expiration
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.storage.delete(key);
      return null;
    }

    if (type === "json") {
      return JSON.parse(entry.value) as T;
    }
    return entry.value as T;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    this.storage.set(key, {
      value,
      ttl: options?.expirationTtl,
      timestamp: Date.now()
    });
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }

  clear(): void {
    this.storage.clear();
  }

  // Helper method to simulate KV failures
  simulateFailure: boolean = false;

  async getWithFailure<T>(key: string, type?: string): Promise<T | null> {
    if (this.simulateFailure) {
      throw new Error("KV operation failed");
    }
    return this.get(key, type);
  }

  async putWithFailure(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    if (this.simulateFailure) {
      throw new Error("KV operation failed");
    }
    return this.put(key, value, options);
  }
}

// Mock environment for testing
function createMockEnv(overrides: Partial<Env> = {}): Env {
  const mockKV = new MockKVNamespace();

  return {
    GCP_SERVICE_ACCOUNT: JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      scope: "test-scope",
      token_type: "Bearer",
      id_token: "test-id-token",
      expiry_date: Math.floor(Date.now() / 1000) - 3600, // Expired by default to force refresh
    }),
    GEMINI_PROJECT_ID: "test-project-id",
    GEMINI_CREDS_KV: mockKV as any,
    TOKEN_REFRESH_BUFFER_MINUTES: "5",
    ...overrides,
  };
}

// Mock fetch for token refresh
const originalFetch = globalThis.fetch;

function mockFetch(success: boolean = true, expiresIn: number = 3600) {
  globalThis.fetch = vi.fn().mockImplementation((url: string, options: any) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      if (success) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "new-access-token",
              expires_in: expiresIn,
            }),
        });
      } else {
        return Promise.resolve({
          ok: false,
          text: () => Promise.resolve("Token refresh failed"),
        });
      }
    }
    return originalFetch(url, options);
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe("AuthManager", () => {
  let env: Env;
  let authManager: AuthManager;

  beforeEach(() => {
    env = createMockEnv();
    authManager = new AuthManager(env);
    // Clear singleton instances
    (AuthManager as any).instances.clear();
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("Singleton Pattern", () => {
    it("should return same instance for same environment", () => {
      const instance1 = AuthManager.getInstance(env);
      const instance2 = AuthManager.getInstance(env);
      expect(instance1).toBe(instance2);
    });

    it("should return different instances for different environments", () => {
      const env2 = createMockEnv({ GCP_SERVICE_ACCOUNT: "different-account" });
      const instance1 = AuthManager.getInstance(env);
      const instance2 = AuthManager.getInstance(env2);
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("Token Pre-refresh Mechanism", () => {
    it("should use valid cached token", async () => {
      // Pre-populate KV with valid token
      const validToken: CachedTokenData = {
        access_token: "cached-token",
        expiry_date: Date.now() + 10 * 60 * 1000, // 10 minutes from now
        refresh_count: 1,
        last_used: Date.now() - 1000,
        created_at: Date.now() - 5000,
        token_type: "Bearer",
        scope: "test-scope",
      };

      await env.GEMINI_CREDS_KV.put(
        "oauth_token_cache",
        JSON.stringify(validToken)
      );

      const token = await authManager.getAccessToken();
      expect(token).toBe("cached-token");
    });

    it("should refresh token when approaching expiry", async () => {
      mockFetch(true);

      // Create environment with expired token to force refresh
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);
      const token = await expiredAuthManager.getAccessToken();
      expect(token).toBe("new-access-token");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("oauth2.googleapis.com/token"),
        expect.any(Object)
      );
    });
  });

  describe("Concurrent Token Refresh Prevention", () => {
    it("should handle concurrent token requests without multiple refreshes", async () => {
      mockFetch(true);

      // Create environment with expired token to force refresh
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // Make multiple concurrent requests
      const promises = [
        expiredAuthManager.getAccessToken(),
        expiredAuthManager.getAccessToken(),
        expiredAuthManager.getAccessToken(),
      ];

      const tokens = await Promise.all(promises);

      // All should return the same new token
      expect(tokens[0]).toBe("new-access-token");
      expect(tokens[1]).toBe("new-access-token");
      expect(tokens[2]).toBe("new-access-token");

      // Should only have called fetch once for token refresh
      expect((globalThis.fetch as any).mock.calls.length).toBe(1);
    });
  });

  describe("Enhanced KV Caching", () => {
    it("should store enhanced metadata in cached tokens", async () => {
      mockFetch(true);

      await authManager.initialize();
      const token = await authManager.getAccessToken();

      // Check that enhanced metadata was stored
      const cached = await env.GEMINI_CREDS_KV.get<CachedTokenData>(
        "oauth_token_cache",
        "json"
      );
      expect(cached).toBeTruthy();
      expect(cached!.refresh_count).toBeDefined();
      expect(cached!.last_used).toBeDefined();
      expect(cached!.created_at).toBeDefined();
      expect(cached!.token_type).toBeDefined();
      expect(cached!.scope).toBeDefined();
    });

    it("should increment refresh count on token refresh", async () => {
      mockFetch(true);

      // Create environment with expired token and pre-populate KV with existing refresh count
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // Pre-populate with token that has refresh count
      const existingToken: CachedTokenData = {
        access_token: "old-token",
        expiry_date: Date.now() - 1000, // Expired
        refresh_count: 2,
        last_used: Date.now() - 1000,
        created_at: Date.now() - 5000,
        token_type: "Bearer",
        scope: "test-scope",
      };

      await expiredEnv.GEMINI_CREDS_KV.put(
        "oauth_token_cache",
        JSON.stringify(existingToken)
      );

      await expiredAuthManager.getAccessToken();

      const cached = await expiredEnv.GEMINI_CREDS_KV.get<CachedTokenData>(
        "oauth_token_cache",
        "json"
      );
      expect(cached!.refresh_count).toBe(3); // Should be incremented
    });

    it("should provide cache metrics", async () => {
      mockFetch(true);

      await authManager.initialize();
      await authManager.getAccessToken();

      const metrics = authManager.getCacheMetrics();
      expect(metrics).toBeTruthy();
      expect(metrics!.refreshCount).toBeDefined();
      expect(metrics!.lastUsed).toBeDefined();
      expect(metrics!.cacheAge).toBeDefined();
    });
  });

  describe("Token Lifecycle Management", () => {
    it("should use environment token when valid and not expired", async () => {
      // Create environment with valid token (not expired)
      const validEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "env-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor((Date.now() + 10 * 60 * 1000) / 1000), // 10 minutes from now
        }),
      });

      const validAuthManager = new AuthManager(validEnv);
      const token = await validAuthManager.getAccessToken();
      expect(token).toBe("env-token");
    });

    it("should respect token refresh buffer time", async () => {
      mockFetch(true);

      // Create environment with token that expires within buffer time
      const bufferEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "buffer-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor((Date.now() + 3 * 60 * 1000) / 1000), // 3 minutes from now (within 5-minute buffer)
        }),
        TOKEN_REFRESH_BUFFER_MINUTES: "5",
      });

      const bufferAuthManager = new AuthManager(bufferEnv);
      const token = await bufferAuthManager.getAccessToken();
      
      // Should refresh token due to buffer time
      expect(token).toBe("new-access-token");
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("should update last_used timestamp on token access", async () => {
      // Pre-populate KV with valid token
      const validToken: CachedTokenData = {
        access_token: "cached-token",
        expiry_date: Date.now() + 10 * 60 * 1000,
        refresh_count: 1,
        last_used: Date.now() - 60000, // 1 minute ago
        created_at: Date.now() - 5000,
        token_type: "Bearer",
        scope: "test-scope",
      };

      await env.GEMINI_CREDS_KV.put(
        "oauth_token_cache",
        JSON.stringify(validToken)
      );

      const beforeTime = Date.now();
      await authManager.getAccessToken();
      const afterTime = Date.now();

      const cached = await env.GEMINI_CREDS_KV.get<CachedTokenData>(
        "oauth_token_cache",
        "json"
      );
      
      expect(cached!.last_used).toBeGreaterThanOrEqual(beforeTime);
      expect(cached!.last_used).toBeLessThanOrEqual(afterTime);
    });

    it("should clear token cache properly", async () => {
      // Pre-populate KV with token
      const validToken: CachedTokenData = {
        access_token: "cached-token",
        expiry_date: Date.now() + 10 * 60 * 1000,
        refresh_count: 1,
        last_used: Date.now(),
        created_at: Date.now(),
        token_type: "Bearer",
        scope: "test-scope",
      };

      await env.GEMINI_CREDS_KV.put(
        "oauth_token_cache",
        JSON.stringify(validToken)
      );

      await authManager.clearTokenCache();

      const cached = await env.GEMINI_CREDS_KV.get("oauth_token_cache");
      expect(cached).toBeNull();
      expect(authManager.getCacheMetrics()).toBeNull();
    });
  });

  describe("Advanced Caching Scenarios", () => {
    it("should handle KV storage failures gracefully", async () => {
      mockFetch(true);

      // Create a mock KV that fails
      const failingKV = new MockKVNamespace();
      failingKV.simulateFailure = true;

      const failingEnv = createMockEnv({
        GEMINI_CREDS_KV: failingKV as any,
      });

      const failingAuthManager = new AuthManager(failingEnv);
      
      // Should still work despite KV failures
      const token = await failingAuthManager.getAccessToken();
      expect(token).toBe("new-access-token");
    });

    it("should handle TTL expiration in KV", async () => {
      mockFetch(true);

      // Pre-populate KV with token that has short TTL
      const shortTtlToken: CachedTokenData = {
        access_token: "ttl-token",
        expiry_date: Date.now() + 10 * 60 * 1000,
        refresh_count: 1,
        last_used: Date.now(),
        created_at: Date.now(),
        token_type: "Bearer",
        scope: "test-scope",
      };

      await env.GEMINI_CREDS_KV.put(
        "oauth_token_cache",
        JSON.stringify(shortTtlToken),
        { expirationTtl: 1 } // 1 second TTL
      );

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      const token = await authManager.getAccessToken();
      
      // Should refresh token since cached one expired
      expect(token).toBe("new-access-token");
    });

    it("should cache token with appropriate TTL", async () => {
      mockFetch(true, 7200); // 2 hours

      await authManager.initialize();
      await authManager.getAccessToken();

      // Verify token was cached with proper TTL
      const cached = await env.GEMINI_CREDS_KV.get<CachedTokenData>(
        "oauth_token_cache",
        "json"
      );
      expect(cached).toBeTruthy();
      expect(cached!.access_token).toBe("new-access-token");
    });
  });

  describe("Concurrent Operations", () => {
    it("should queue requests during token refresh", async () => {
      mockFetch(true);

      // Create environment with expired token
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600,
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // Start multiple requests that will trigger refresh
      const promises = Array.from({ length: 5 }, () => 
        expiredAuthManager.getAccessToken()
      );

      const tokens = await Promise.all(promises);

      // All should get the same refreshed token
      tokens.forEach(token => {
        expect(token).toBe("new-access-token");
      });

      // Should only refresh once
      expect((globalThis.fetch as any).mock.calls.length).toBe(1);
    });

    it("should handle stale refresh operations", async () => {
      mockFetch(true);

      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600,
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // Simulate stale refresh operation by setting timestamp to past
      (expiredAuthManager as any).refreshOperation = {
        promise: Promise.resolve(),
        timestamp: Date.now() - 35000 // 35 seconds ago (stale)
      };

      const token = await expiredAuthManager.getAccessToken();
      expect(token).toBe("new-access-token");
    });
  });

  describe("API Endpoint Calling", () => {
    it("should call endpoint with proper authorization", async () => {
      mockFetch(true);

      // Mock API endpoint response
      globalThis.fetch = vi.fn().mockImplementation((url: string, options: any) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              access_token: "new-access-token",
              expires_in: 3600,
            }),
          });
        }
        if (url.includes("cloudcode-pa.googleapis.com")) {
          expect(options.headers.Authorization).toBe("Bearer new-access-token");
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ result: "success" }),
          });
        }
        return originalFetch(url, options);
      });

      const result = await authManager.callEndpoint("testMethod", { test: "data" });
      expect(result).toEqual({ result: "success" });
    });

    it("should retry on 401 error once", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string, options: any) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              access_token: "new-access-token",
              expires_in: 3600,
            }),
          });
        }
        if (url.includes("cloudcode-pa.googleapis.com")) {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: false,
              status: 401,
              text: () => Promise.resolve("Unauthorized"),
            });
          } else {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ result: "success" }),
            });
          }
        }
        return originalFetch(url, options);
      });

      const result = await authManager.callEndpoint("testMethod", { test: "data" });
      expect(result).toEqual({ result: "success" });
      expect(callCount).toBe(2); // Should retry once
    });

    it("should not retry on non-401 errors", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string, options: any) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              access_token: "new-access-token",
              expires_in: 3600,
            }),
          });
        }
        if (url.includes("cloudcode-pa.googleapis.com")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Internal Server Error"),
          });
        }
        return originalFetch(url, options);
      });

      await expect(authManager.callEndpoint("testMethod", { test: "data" }))
        .rejects.toThrow("API call to testMethod failed with status 500");
    });
  });

  describe("Error Handling and Retry Logic", () => {
    it("should handle token refresh failure gracefully", async () => {
      mockFetch(false); // Mock failed refresh

      // Create environment with expired token to force refresh
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      await expect(expiredAuthManager.getAccessToken()).rejects.toThrow(
        "Token refresh failed"
      );
    });

    it("should handle missing GCP_SERVICE_ACCOUNT", async () => {
      const envWithoutAccount = createMockEnv({ GCP_SERVICE_ACCOUNT: "" });
      const manager = new AuthManager(envWithoutAccount);

      await expect(manager.initialize()).rejects.toThrow(
        "`GCP_SERVICE_ACCOUNT` environment variable not set"
      );
    });

    it("should handle malformed GCP_SERVICE_ACCOUNT JSON", async () => {
      const envWithBadJson = createMockEnv({ 
        GCP_SERVICE_ACCOUNT: "invalid-json" 
      });
      const manager = new AuthManager(envWithBadJson);

      await expect(manager.initialize()).rejects.toThrow();
    });

    it("should handle network errors during token refresh", async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => {
        throw new Error("Network error");
      });

      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600,
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      await expect(expiredAuthManager.getAccessToken()).rejects.toThrow("Network error");
    });

    it("should reset initialization promise on refresh failure", async () => {
      mockFetch(false);

      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600,
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // First attempt should fail
      await expect(expiredAuthManager.getAccessToken()).rejects.toThrow();

      // Mock successful refresh for second attempt
      mockFetch(true);

      // Second attempt should succeed (initialization promise was reset)
      const token = await expiredAuthManager.getAccessToken();
      expect(token).toBe("new-access-token");
    });
  });

  describe("Performance and Metrics", () => {
    it("should provide accurate cache metrics", async () => {
      mockFetch(true);

      await authManager.initialize();
      await authManager.getAccessToken();

      const metrics = authManager.getCacheMetrics();
      expect(metrics).toBeTruthy();
      expect(typeof metrics!.refreshCount).toBe("number");
      expect(typeof metrics!.lastUsed).toBe("number");
      expect(typeof metrics!.cacheAge).toBe("number");
      expect(metrics!.cacheAge).toBeGreaterThanOrEqual(0);
    });

    it("should return null metrics when no cached token", async () => {
      const metrics = authManager.getCacheMetrics();
      expect(metrics).toBeNull();
    });

    it("should track refresh count accurately across multiple refreshes", async () => {
      mockFetch(true);

      // Create environment that will force multiple refreshes
      const expiredEnv = createMockEnv({
        GCP_SERVICE_ACCOUNT: JSON.stringify({
          access_token: "expired-token",
          refresh_token: "test-refresh-token",
          scope: "test-scope",
          token_type: "Bearer",
          id_token: "test-id-token",
          expiry_date: Math.floor(Date.now() / 1000) - 3600,
        }),
      });

      const expiredAuthManager = new AuthManager(expiredEnv);

      // First refresh
      await expiredAuthManager.getAccessToken();
      let metrics = expiredAuthManager.getCacheMetrics();
      expect(metrics!.refreshCount).toBe(1);

      // Force another refresh by clearing cache and using expired token
      await expiredAuthManager.clearTokenCache();
      await expiredAuthManager.getAccessToken();
      metrics = expiredAuthManager.getCacheMetrics();
      expect(metrics!.refreshCount).toBe(1); // Reset since cache was cleared
    });
  });
});
