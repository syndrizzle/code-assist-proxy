import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerformanceMetricsCollector, PerformanceMonitor } from '../src/performance-metrics';
import { RequestContext } from '../src/types';

// Mock console methods
const mockConsole = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
vi.stubGlobal('console', mockConsole);

describe('PerformanceMetricsCollector', () => {
    let metricsCollector: PerformanceMetricsCollector;
    let mockContext: RequestContext;

    beforeEach(() => {
        // Reset singleton instance
        (PerformanceMetricsCollector as any).instance = undefined;
        metricsCollector = PerformanceMetricsCollector.getInstance();
        
        mockContext = {
            requestId: 'test-req-123',
            startTime: Date.now() - 1000,
            model: 'gemini-pro',
            action: 'generateContent',
            isStreaming: false,
            metrics: {
                requestStartTime: Date.now() - 1000,
                authTime: 100,
                transformTime: 50,
                upstreamTime: 800,
                totalTime: 1000,
            },
            timings: {
                start: Date.now() - 1000,
                authStart: Date.now() - 950,
                authEnd: Date.now() - 850,
                transformStart: Date.now() - 850,
                transformEnd: Date.now() - 800,
                upstreamStart: Date.now() - 800,
                upstreamEnd: Date.now() - 50,
                end: Date.now(),
            },
            retryCount: 0,
            cacheUsed: true,
        };
    });

    describe('getInstance', () => {
        it('should return singleton instance', () => {
            const instance1 = PerformanceMetricsCollector.getInstance();
            const instance2 = PerformanceMetricsCollector.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe('recordRequest', () => {
        it('should record successful request metrics', () => {
            metricsCollector.recordRequest(mockContext, false, 200);
            
            const systemMetrics = metricsCollector.getSystemMetrics();
            expect(systemMetrics.totalRequests).toBe(1);
            expect(systemMetrics.cacheHitCount).toBe(1);
            expect(systemMetrics.cacheMissCount).toBe(0);
        });

        it('should record failed request metrics', () => {
            metricsCollector.recordRequest(mockContext, true, 500);
            
            const systemMetrics = metricsCollector.getSystemMetrics();
            expect(systemMetrics.totalRequests).toBe(1);
        });

        it('should handle cache miss correctly', () => {
            const contextWithoutCache = { ...mockContext, cacheUsed: false };
            metricsCollector.recordRequest(contextWithoutCache, false, 200);
            
            const systemMetrics = metricsCollector.getSystemMetrics();
            expect(systemMetrics.cacheHitCount).toBe(0);
            expect(systemMetrics.cacheMissCount).toBe(1);
        });
    });

    describe('recordTokenRefresh', () => {
        it('should increment token refresh count', () => {
            metricsCollector.recordTokenRefresh();
            metricsCollector.recordTokenRefresh();
            
            const systemMetrics = metricsCollector.getSystemMetrics();
            expect(systemMetrics.tokenRefreshCount).toBe(2);
        });
    });

    describe('updateActiveRequests', () => {
        it('should update active request count', () => {
            metricsCollector.updateActiveRequests(5);
            
            const systemMetrics = metricsCollector.getSystemMetrics();
            expect(systemMetrics.activeRequests).toBe(5);
        });
    });

    describe('getMetricsSnapshot', () => {
        it('should return comprehensive metrics snapshot', () => {
            // Record some test data
            metricsCollector.recordRequest(mockContext, false, 200);
            metricsCollector.recordRequest({ ...mockContext, metrics: { ...mockContext.metrics, totalTime: 2000 } }, false, 200);
            metricsCollector.recordRequest(mockContext, true, 500);
            metricsCollector.updateActiveRequests(3);
            
            const snapshot = metricsCollector.getMetricsSnapshot();
            
            expect(snapshot.totalRequests).toBe(3);
            expect(snapshot.activeRequests).toBe(3);
            expect(snapshot.averageResponseTime).toBeGreaterThan(0);
            expect(snapshot.p95ResponseTime).toBeGreaterThan(0);
            expect(snapshot.p99ResponseTime).toBeGreaterThan(0);
            expect(snapshot.errorRate).toBeGreaterThan(0);
            expect(snapshot.cacheHitRate).toBeGreaterThan(0);
        });
    });

    describe('getModelPerformanceBreakdown', () => {
        it('should provide per-model performance statistics', () => {
            // Record requests for different models
            metricsCollector.recordRequest(mockContext, false, 200);
            metricsCollector.recordRequest({ ...mockContext, model: 'gemini-pro-vision' }, false, 200);
            metricsCollector.recordRequest({ ...mockContext, model: 'gemini-pro' }, true, 500);
            
            const breakdown = metricsCollector.getModelPerformanceBreakdown();
            
            expect(breakdown['gemini-pro']).toBeDefined();
            expect(breakdown['gemini-pro-vision']).toBeDefined();
            expect(breakdown['gemini-pro'].requestCount).toBe(2);
            expect(breakdown['gemini-pro-vision'].requestCount).toBe(1);
            expect(breakdown['gemini-pro'].errorRate).toBeGreaterThan(0);
            expect(breakdown['gemini-pro-vision'].errorRate).toBe(0);
        });
    });

    describe('getSlowRequests', () => {
        it('should identify slow requests above threshold', () => {
            const slowContext = { ...mockContext, metrics: { ...mockContext.metrics, totalTime: 6000 } };
            const fastContext = { ...mockContext, metrics: { ...mockContext.metrics, totalTime: 500 } };
            
            metricsCollector.recordRequest(slowContext, false, 200);
            metricsCollector.recordRequest(fastContext, false, 200);
            
            const slowRequests = metricsCollector.getSlowRequests(5000);
            expect(slowRequests).toHaveLength(1);
            expect(slowRequests[0].totalTime).toBe(6000);
        });
    });

    describe('exportMetrics', () => {
        it('should export metrics in JSON format', () => {
            metricsCollector.recordRequest(mockContext, false, 200);
            
            const jsonExport = metricsCollector.exportMetrics('json');
            const parsed = JSON.parse(jsonExport);
            
            expect(parsed.snapshot).toBeDefined();
            expect(parsed.systemMetrics).toBeDefined();
            expect(parsed.modelBreakdown).toBeDefined();
            expect(parsed.slowRequests).toBeDefined();
        });

        it('should export metrics in Prometheus format', () => {
            metricsCollector.recordRequest(mockContext, false, 200);
            
            const prometheusExport = metricsCollector.exportMetrics('prometheus');
            
            expect(prometheusExport).toContain('gemini_proxy_total_requests');
            expect(prometheusExport).toContain('gemini_proxy_active_requests');
            expect(prometheusExport).toContain('gemini_proxy_response_time_ms');
            expect(prometheusExport).toContain('gemini_proxy_error_rate');
            expect(prometheusExport).toContain('gemini_proxy_cache_hit_rate');
        });
    });
});

describe('PerformanceMonitor', () => {
    let performanceMonitor: PerformanceMonitor;
    let metricsCollector: PerformanceMetricsCollector;

    beforeEach(() => {
        // Reset singleton instances
        (PerformanceMonitor as any).instance = undefined;
        (PerformanceMetricsCollector as any).instance = undefined;
        
        performanceMonitor = PerformanceMonitor.getInstance();
        metricsCollector = PerformanceMetricsCollector.getInstance();
        
        // Clear console mocks
        mockConsole.log.mockClear();
        mockConsole.warn.mockClear();
    });

    describe('getInstance', () => {
        it('should return singleton instance', () => {
            const instance1 = PerformanceMonitor.getInstance();
            const instance2 = PerformanceMonitor.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe('checkPerformanceAlerts', () => {
        it('should detect high error rate', () => {
            // Simulate high error rate
            const mockContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 1000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: false,
            } as RequestContext;

            // Record multiple failed requests to trigger high error rate
            for (let i = 0; i < 10; i++) {
                metricsCollector.recordRequest(mockContext, true, 500);
            }

            const alerts = performanceMonitor.checkPerformanceAlerts();
            expect(alerts.some(alert => alert.includes('High error rate'))).toBe(true);
        });

        it('should detect low cache hit rate', () => {
            const mockContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 1000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: false,
            } as RequestContext;

            // Record multiple requests with no cache hits
            for (let i = 0; i < 10; i++) {
                metricsCollector.recordRequest(mockContext, false, 200);
            }

            const alerts = performanceMonitor.checkPerformanceAlerts();
            expect(alerts.some(alert => alert.includes('Low cache hit rate'))).toBe(true);
        });

        it('should detect high active request count', () => {
            metricsCollector.updateActiveRequests(150);

            const alerts = performanceMonitor.checkPerformanceAlerts();
            expect(alerts.some(alert => alert.includes('High active request count'))).toBe(true);
        });

        it('should detect slow requests', () => {
            const slowContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 6000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: true,
            } as RequestContext;

            metricsCollector.recordRequest(slowContext, false, 200);

            const alerts = performanceMonitor.checkPerformanceAlerts();
            expect(alerts.some(alert => alert.includes('slow requests detected'))).toBe(true);
        });

        it('should return empty array when no alerts', () => {
            const goodContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 1000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: true,
            } as RequestContext;

            metricsCollector.recordRequest(goodContext, false, 200);
            metricsCollector.updateActiveRequests(5);

            const alerts = performanceMonitor.checkPerformanceAlerts();
            expect(alerts).toHaveLength(0);
        });
    });

    describe('logPerformanceSummary', () => {
        it('should log comprehensive performance summary', () => {
            const mockContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 1000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: true,
            } as RequestContext;

            metricsCollector.recordRequest(mockContext, false, 200);
            metricsCollector.recordTokenRefresh();

            performanceMonitor.logPerformanceSummary();

            expect(mockConsole.log).toHaveBeenCalledWith('=== Performance Summary ===');
            expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Total Requests:'));
            expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Average Response Time:'));
            expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Error Rate:'));
            expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Cache Hit Rate:'));
        });

        it('should log performance alerts when present', () => {
            // Create conditions for alerts
            const mockContext = {
                requestId: 'test-req-123',
                startTime: Date.now(),
                model: 'gemini-pro',
                action: 'generateContent',
                isStreaming: false,
                metrics: { requestStartTime: Date.now(), authTime: 100, transformTime: 50, upstreamTime: 800, totalTime: 6000 },
                timings: { start: Date.now() },
                retryCount: 0,
                cacheUsed: false,
            } as RequestContext;

            for (let i = 0; i < 10; i++) {
                metricsCollector.recordRequest(mockContext, true, 500);
            }

            performanceMonitor.logPerformanceSummary();

            expect(mockConsole.warn).toHaveBeenCalledWith('\n=== Performance Alerts ===');
            expect(mockConsole.warn).toHaveBeenCalledWith(expect.stringContaining('⚠️'));
        });
    });
});