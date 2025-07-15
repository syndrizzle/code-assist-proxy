import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleProxy } from "../src/handler";
import { AuthManager } from "../src/auth";
import { Env } from "../src/types";

// Mock KV namespace for testing
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

  // Helper methods for performance testing
  getStorageSize(): number {
    return this.storage.size;
  }

  getMemoryUsage(): number {
    let totalSize = 0;
    for (const [key, entry] of this.storage) {
      totalSize += key.length + entry.value.length;
    }
    return totalSize;
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
      expiry_date: Math.floor((Date.now() + 10 * 60 * 1000) / 1000), // Valid for 10 minutes
    }),
    GEMINI_PROJECT_ID: "test-project-id",
    GEMINI_CREDS_KV: mockKV as any,
    TOKEN_REFRESH_BUFFER_MINUTES: "5",
    ENABLE_CONNECTION_POOLING: "true",
    MAX_CONCURRENT_REQUESTS: "100",
    CIRCUIT_BREAKER_THRESHOLD: "5",
    CIRCUIT_BREAKER_TIMEOUT_MS: "30000",
    ...overrides,
  };
}

// Mock fetch for performance testing
const originalFetch = globalThis.fetch;

interface PerformanceMockOptions {
  responseDelay?: number;
  tokenRefreshDelay?: number;
  streaming?: boolean;
  largeResponse?: boolean;
  concurrentTokenRefresh?: boolean;
}

function mockFetchForPerformance(options: PerformanceMockOptions = {}) {
  const {
    responseDelay = 0,
    tokenRefreshDelay = 0,
    streaming = false,
    largeResponse = false,
    concurrentTokenRefresh = false
  } = options;

  let tokenRefreshCount = 0;

  globalThis.fetch = vi.fn().mockImplementation(async (url: string, requestOptions: any) => {
    // Add artificial delay for performance testing
    if (responseDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, responseDelay));
    }

    // Token refresh endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenRefreshCount++;
      
      if (tokenRefreshDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, tokenRefreshDelay));
      }

      // Simulate concurrent token refresh scenario
      if (concurrentTokenRefresh && tokenRefreshCount > 1) {
        // Add extra delay for subsequent refreshes to test queuing
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return {
        ok: true,
        json: () => Promise.resolve({
          access_token: `new-access-token-${tokenRefreshCount}`,
          expires_in: 3600,
        }),
      };
    }

    // Code Assist API endpoint
    if (url.includes("cloudcode-pa.googleapis.com")) {
      if (streaming) {
        // Create large streaming response for performance testing
        const chunks = largeResponse ? 1000 : 10;
        const sseData = Array.from({ length: chunks }, (_, i) => 
          `data: {"response": {"candidates": [{"content": {"parts": [{"text": "Chunk ${i} "}]}}]}}\n`
        ).join('') + 'data: [DONE]\n';
        
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          }
        });

        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "text/event-stream" }),
          body: stream,
        };
      } else {
        // Create large JSON response for performance testing
        const responseSize = largeResponse ? 10000 : 100;
        const largeText = "A".repeat(responseSize);
        
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () => Promise.resolve({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: largeText }]
                  }
                }
              ]
            }
          }),
        };
      }
    }

    return originalFetch(url, requestOptions);
  });

  return { getTokenRefreshCount: () => tokenRefreshCount };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Performance measurement utilities
class PerformanceTracker {
  private measurements: Map<string, number[]> = new Map();

  startMeasurement(name: string): () => number {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      if (!this.measurements.has(name)) {
        this.measurements.set(name, []);
      }
      this.measurements.get(name)!.push(duration);
      return duration;
    };
  }

  getStats(name: string): { avg: number; min: number; max: number; count: number } | null {
    const measurements = this.measurements.get(name);
    if (!measurements || measurements.length === 0) return null;

    const avg = measurements.reduce((sum, val) => sum + val, 0) / measurements.length;
    const min = Math.min(...measurements);
    const max = Math.max(...measurements);
    
    return { avg, min, max, count: measurements.length };
  }

  clear(): void {
    this.measurements.clear();
  }
}

describe("Performance and Load Testing", () => {
  let env: Env;
  let performanceTracker: PerformanceTracker;

  beforeEach(() => {
    env = createMockEnv();
    performanceTracker = new PerformanceTracker();
    // Clear singleton instances
    (AuthManager as any).instances.clear();
  });

  afterEach(() => {
    restoreFetch();
    performanceTracker.clear();
  });

  describe("Concurrent Request Handling", () => {
    it("should handle 50 concurrent requests efficiently", async () => {
      mockFetchForPerformance({ responseDelay: 10 });

      const concurrentRequests = 50;
      const requests = Array.from({ length: concurrentRequests }, (_, i) => 
        new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Concurrent request ${i}` }] }]
          })
        })
      );

      const endMeasurement = performanceTracker.startMeasurement("concurrent-requests");
      const startTime = Date.now();

      const responses = await Promise.all(
        requests.map(request => handleProxy(request, env))
      );

      const totalTime = endMeasurement();
      const endTime = Date.now();

      // All requests should succeed
      responses.forEach((response, i) => {
        expect(response.status).toBe(200);
      });

      // Performance assertions
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(endTime - startTime).toBeLessThan(5000);

      console.log(`Concurrent requests completed in ${totalTime}ms`);
      console.log(`Average time per request: ${totalTime / concurrentRequests}ms`);
    }, 10000);

    it("should handle 100 concurrent requests without blocking", async () => {
      mockFetchForPerformance({ responseDelay: 5 });

      const concurrentRequests = 100;
      const batchSize = 20;
      const batches = Math.ceil(concurrentRequests / batchSize);

      const endMeasurement = performanceTracker.startMeasurement("high-concurrency");

      for (let batch = 0; batch < batches; batch++) {
        const batchRequests = Array.from({ length: Math.min(batchSize, concurrentRequests - batch * batchSize) }, (_, i) => 
          new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Batch ${batch} request ${i}` }] }]
            })
          })
        );

        const batchResponses = await Promise.all(
          batchRequests.map(request => handleProxy(request, env))
        );

        // All batch requests should succeed
        batchResponses.forEach(response => {
          expect(response.status).toBe(200);
        });
      }

      const totalTime = endMeasurement();
      expect(totalTime).toBeLessThan(10000); // Should complete within 10 seconds

      console.log(`High concurrency test completed in ${totalTime}ms`);
    }, 15000);

    it("should maintain performance under sustained load", async () => {
      mockFetchForPerformance({ responseDelay: 1 });

      const sustainedRequests = 200;
      const intervalMs = 10; // Send request every 10ms
      const responses: Response[] = [];

      const endMeasurement = performanceTracker.startMeasurement("sustained-load");

      for (let i = 0; i < sustainedRequests; i++) {
        const request = new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Sustained request ${i}` }] }]
          })
        });

        // Send requests at intervals to simulate sustained load
        const responsePromise = handleProxy(request, env);
        responses.push(await responsePromise);

        if (i < sustainedRequests - 1) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      }

      const totalTime = endMeasurement();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Performance should remain consistent
      expect(totalTime).toBeLessThan(15000); // Should complete within 15 seconds

      console.log(`Sustained load test completed in ${totalTime}ms`);
      console.log(`Average request rate: ${(sustainedRequests / totalTime * 1000).toFixed(2)} req/s`);
    }, 20000);
  });

  describe("Memory Usage and Streaming Performance", () => {
    it("should handle large streaming responses efficiently", async () => {
      mockFetchForPerformance({ streaming: true, largeResponse: true });

      const request = new Request("https://example.com/v1/models/gemini-pro:streamGenerateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Generate large streaming response" }] }]
        })
      });

      const endMeasurement = performanceTracker.startMeasurement("large-streaming");
      const response = await handleProxy(request, env);
      
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Read the streaming response
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      let totalChunks = 0;
      let totalBytes = 0;

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            totalChunks++;
            totalBytes += value.length;
          }
        } finally {
          reader.releaseLock();
        }
      }

      const totalTime = endMeasurement();

      // Performance assertions for streaming
      expect(totalTime).toBeLessThan(2000); // Should complete within 2 seconds
      expect(totalChunks).toBeGreaterThan(0);
      expect(totalBytes).toBeGreaterThan(1000); // Should have processed significant data

      console.log(`Large streaming response processed in ${totalTime}ms`);
      console.log(`Processed ${totalChunks} chunks, ${totalBytes} bytes`);
      console.log(`Streaming rate: ${(totalBytes / totalTime * 1000).toFixed(2)} bytes/s`);
    }, 5000);

    it("should handle large JSON responses without memory issues", async () => {
      mockFetchForPerformance({ largeResponse: true });

      const request = new Request("https://example.com/v1/models/gemini-pro:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Generate large response" }] }]
        })
      });

      const endMeasurement = performanceTracker.startMeasurement("large-json");
      const response = await handleProxy(request, env);
      
      expect(response.status).toBe(200);

      const responseBody = await response.json();
      const totalTime = endMeasurement();

      // Verify large response was handled
      expect(responseBody.candidates).toBeDefined();
      expect(responseBody.candidates[0].content.parts[0].text.length).toBeGreaterThan(1000);

      // Performance assertions
      expect(totalTime).toBeLessThan(1000); // Should complete within 1 second

      console.log(`Large JSON response processed in ${totalTime}ms`);
      console.log(`Response size: ${responseBody.candidates[0].content.parts[0].text.length} characters`);
    }, 3000);

    it("should maintain memory efficiency with multiple large responses", async () => {
      mockFetchForPerformance({ largeResponse: true });

      const requests = Array.from({ length: 10 }, (_, i) => 
        new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Large response request ${i}` }] }]
          })
        })
      );

      const endMeasurement = performanceTracker.startMeasurement("memory-efficiency");
      const mockKV = env.GEMINI_CREDS_KV as any as MockKVNamespace;
      const initialMemoryUsage = mockKV.getMemoryUsage();

      const responses = await Promise.all(
        requests.map(request => handleProxy(request, env))
      );

      const totalTime = endMeasurement();
      const finalMemoryUsage = mockKV.getMemoryUsage();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Memory usage should not grow excessively
      const memoryGrowth = finalMemoryUsage - initialMemoryUsage;
      expect(memoryGrowth).toBeLessThan(100000); // Less than 100KB growth

      console.log(`Memory efficiency test completed in ${totalTime}ms`);
      console.log(`Memory growth: ${memoryGrowth} bytes`);
    }, 5000);
  });

  describe("Token Refresh Under High Concurrency", () => {
    it("should handle concurrent token refresh efficiently", async () => {
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

      const { getTokenRefreshCount } = mockFetchForPerformance({ 
        concurrentTokenRefresh: true,
        tokenRefreshDelay: 50 
      });

      const concurrentRequests = 20;
      const requests = Array.from({ length: concurrentRequests }, (_, i) => 
        new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Concurrent token refresh test ${i}` }] }]
          })
        })
      );

      const endMeasurement = performanceTracker.startMeasurement("concurrent-token-refresh");

      const responses = await Promise.all(
        requests.map(request => handleProxy(request, expiredEnv))
      );

      const totalTime = endMeasurement();
      const tokenRefreshCount = getTokenRefreshCount();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Should not refresh token excessively (ideally only once)
      expect(tokenRefreshCount).toBeLessThanOrEqual(3); // Allow some variance due to timing

      console.log(`Concurrent token refresh test completed in ${totalTime}ms`);
      console.log(`Token refreshes: ${tokenRefreshCount}`);
      console.log(`Requests per token refresh: ${concurrentRequests / tokenRefreshCount}`);
    }, 10000);

    it("should queue requests during token refresh", async () => {
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

      const { getTokenRefreshCount } = mockFetchForPerformance({ 
        tokenRefreshDelay: 200 // Longer delay to test queuing
      });

      const sequentialRequests = 5;
      const responses: Response[] = [];

      const endMeasurement = performanceTracker.startMeasurement("token-refresh-queuing");

      // Send requests sequentially to test queuing behavior
      for (let i = 0; i < sequentialRequests; i++) {
        const request = new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Queued request ${i}` }] }]
          })
        });

        const response = await handleProxy(request, expiredEnv);
        responses.push(response);
      }

      const totalTime = endMeasurement();
      const tokenRefreshCount = getTokenRefreshCount();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Should minimize token refreshes through queuing
      expect(tokenRefreshCount).toBeLessThanOrEqual(2);

      console.log(`Token refresh queuing test completed in ${totalTime}ms`);
      console.log(`Token refreshes: ${tokenRefreshCount}`);
    }, 5000);

    it("should handle token refresh failures gracefully under load", async () => {
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

      // Mock failing token refresh
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve("Token refresh failed"),
          });
        }
        return originalFetch(url);
      });

      const concurrentRequests = 10;
      const requests = Array.from({ length: concurrentRequests }, (_, i) => 
        new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Failed token refresh test ${i}` }] }]
          })
        })
      );

      const endMeasurement = performanceTracker.startMeasurement("token-refresh-failure");

      const responses = await Promise.allSettled(
        requests.map(request => handleProxy(request, expiredEnv))
      );

      const totalTime = endMeasurement();

      // All requests should fail gracefully (not crash)
      responses.forEach(result => {
        expect(result.status).toBe("fulfilled");
        if (result.status === "fulfilled") {
          expect(result.value.status).toBeGreaterThanOrEqual(400);
        }
      });

      // Should complete quickly even with failures
      expect(totalTime).toBeLessThan(3000);

      console.log(`Token refresh failure test completed in ${totalTime}ms`);
    }, 5000);
  });

  describe("Performance Benchmarks", () => {
    it("should meet latency requirements for simple requests", async () => {
      mockFetchForPerformance({ responseDelay: 1 });

      const benchmarkRequests = 100;
      const latencies: number[] = [];

      for (let i = 0; i < benchmarkRequests; i++) {
        const request = new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Benchmark request ${i}` }] }]
          })
        });

        const endMeasurement = performanceTracker.startMeasurement(`request-${i}`);
        const response = await handleProxy(request, env);
        const latency = endMeasurement();

        expect(response.status).toBe(200);
        latencies.push(latency);
      }

      // Calculate performance statistics
      const avgLatency = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
      const minLatency = Math.min(...latencies);
      const maxLatency = Math.max(...latencies);
      const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

      // Performance assertions
      expect(avgLatency).toBeLessThan(100); // Average latency < 100ms
      expect(p95Latency).toBeLessThan(200); // 95th percentile < 200ms

      console.log(`Latency Benchmark Results:`);
      console.log(`  Average: ${avgLatency.toFixed(2)}ms`);
      console.log(`  Min: ${minLatency.toFixed(2)}ms`);
      console.log(`  Max: ${maxLatency.toFixed(2)}ms`);
      console.log(`  95th percentile: ${p95Latency.toFixed(2)}ms`);
    }, 15000);

    it("should maintain throughput under mixed workload", async () => {
      mockFetchForPerformance({ responseDelay: 5 });

      const mixedRequests = [
        // Regular requests
        ...Array.from({ length: 30 }, (_, i) => ({
          type: 'regular',
          request: new Request(`https://example.com/v1/models/gemini-pro:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Regular request ${i}` }] }]
            })
          })
        })),
        // Streaming requests
        ...Array.from({ length: 10 }, (_, i) => ({
          type: 'streaming',
          request: new Request(`https://example.com/v1/models/gemini-pro:streamGenerateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Streaming request ${i}` }] }]
            })
          })
        })),
        // Count tokens requests
        ...Array.from({ length: 10 }, (_, i) => ({
          type: 'countTokens',
          request: new Request(`https://example.com/v1/models/gemini-pro:countTokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              generateContentRequest: {
                contents: [{ parts: [{ text: `Count tokens request ${i}` }] }]
              }
            })
          })
        }))
      ];

      // Shuffle requests to simulate mixed workload
      for (let i = mixedRequests.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mixedRequests[i], mixedRequests[j]] = [mixedRequests[j], mixedRequests[i]];
      }

      const endMeasurement = performanceTracker.startMeasurement("mixed-workload");

      const responses = await Promise.all(
        mixedRequests.map(({ request }) => handleProxy(request, env))
      );

      const totalTime = endMeasurement();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Calculate throughput
      const throughput = mixedRequests.length / totalTime * 1000; // requests per second

      // Performance assertions
      expect(throughput).toBeGreaterThan(10); // At least 10 req/s
      expect(totalTime).toBeLessThan(10000); // Complete within 10 seconds

      console.log(`Mixed Workload Results:`);
      console.log(`  Total requests: ${mixedRequests.length}`);
      console.log(`  Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);
  });
});