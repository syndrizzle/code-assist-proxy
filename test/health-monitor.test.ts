import { describe, it, expect, beforeEach, vi, MockedFunction } from 'vitest';
import { HealthMonitor } from '../src/health-monitor';
import { PerformanceMetricsCollector, PerformanceMonitor } from '../src/performance-metrics';
import { AuthManager } from '../src/auth';
import { ConnectionPool } from '../src/connection-pool';
import { CircuitBreaker } from '../src/circuit-breaker';
import { Env } from '../src/types';

// Mock dependencies
vi.mock('../src/performance-metrics');
vi.mock('../src/auth');
vi.mock('../src/connection-pool');
vi.mock('../src/circuit-breaker');

const mockConsole = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
vi.stubGlobal('console', mockConsole);

describe('HealthMonitor', () => {
    let healthMonitor: HealthMonitor;
    let mockEnv: Env;
    let mockMetricsCollector: any;
    let mockPerformanceMonitor: any;
    let mockAuthManager: any;
    let mockConnectionPool: any;
    let mockCircuitBreaker: any;

    beforeEach(() => {
        // Reset singleton instance
        (HealthMonitor as any).instance = undefined;
        
        // Setup mock environment
        mockEnv = {
            GCP_SERVICE_ACCOUNT: JSON.stringify({
                access_token: 'test-token',
                refresh_token: 'test-refresh-token',
                expiry_date: Date.now() / 1000 + 3600,
            }),
            GEMINI_CREDS_KV: {
                get: vi.fn(),
                put: vi.fn(),
                delete: vi.fn(),
            } as any,
        } as Env;

        // Setup mocks
        mockMetricsCollector = {
            getMetricsSnapshot: vi.fn().mockReturnValue({
                timestamp: Date.now(),
                totalRequests: 100,
                activeRequests: 5,
                averageResponseTime: 500,
                p95ResponseTime: 800,
                p99ResponseTime: 1200,
                errorRate: 2.5,
                cacheHitRate: 85,
                tokenRefreshCount: 3,
                circuitBreakerTrips: 0,
            }),
            getSystemMetrics: vi.fn().mockReturnValue({
                activeRequests: 5,
                totalRequests: 100,
                errorRate: 2.5,
                averageResponseTime: 500,
                tokenRefreshCount: 3,
                cacheHitCount: 85,
                cacheMissCount: 15,
            }),
            exportMetrics: vi.fn().mockReturnValue('{"test": "metrics"}'),
        };

        mockPerformanceMonitor = {
            checkPerformanceAlerts: vi.fn().mockReturnValue([]),
        };

        mockAuthManager = {
            initialize: vi.fn().mockResolvedValue(undefined),
            getAccessToken: vi.fn().mockResolvedValue('test-access-token-valid-length'),
            getCacheMetrics: vi.fn().mockReturnValue({
                refreshCount: 3,
                lastUsed: Date.now(),
                cacheAge: 3600000,
            }),
        };

        mockConnectionPool = {
            getMetrics: vi.fn().mockReturnValue({
                activeConnections: 2,
                totalConnections: 5,
                idleConnections: 3,
                maxConnections: 10,
            }),
        };

        mockCircuitBreaker = {
            getState: vi.fn().mockReturnValue({
                state: 'CLOSED',
                failureCount: 0,
                lastFailureTime: 0,
                nextAttemptTime: 0,
                successCount: 10,
            }),
        };

        // Setup mock implementations
        (PerformanceMetricsCollector.getInstance as MockedFunction<any>).mockReturnValue(mockMetricsCollector);
        (PerformanceMonitor.getInstance as MockedFunction<any>).mockReturnValue(mockPerformanceMonitor);
        (AuthManager.getInstance as MockedFunction<any>).mockReturnValue(mockAuthManager);
        (ConnectionPool.getInstance as MockedFunction<any>).mockReturnValue(mockConnectionPool);
        (CircuitBreaker.getInstance as MockedFunction<any>).mockReturnValue(mockCircuitBreaker);

        healthMonitor = HealthMonitor.getInstance();
    });

    describe('getInstance', () => {
        it('should return singleton instance', () => {
            const instance1 = HealthMonitor.getInstance();
            const instance2 = HealthMonitor.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe('performHealthCheck', () => {
        it('should perform comprehensive health check with all systems healthy', async () => {
            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            const result = await healthMonitor.performHealthCheck(mockEnv);

            expect(result.status).toBe('healthy');
            expect(result.checks.authentication.status).toBe('healthy');
            expect(result.checks.kvStorage.status).toBe('healthy');
            expect(result.checks.upstreamApi.status).toBe('healthy');
            expect(result.checks.circuitBreaker.status).toBe('healthy');
            expect(result.checks.performance.status).toBe('healthy');
            expect(result.metrics.totalRequests).toBe(100);
            expect(result.alerts).toEqual([]);
        });

        it('should detect authentication failures', async () => {
            mockAuthManager.getAccessToken.mockRejectedValue(new Error('Auth failed'));

            const result = await healthMonitor.performHealthCheck(mockEnv);

            expect(result.status).toBe('unhealthy');
            expect(result.checks.authentication.status).toBe('unhealthy');
            expect(result.checks.authentication.message).toContain('Authentication failed');
        });

        it('should detect KV storage failures', async () => {
            mockEnv.GEMINI_CREDS_KV.put.mockRejectedValue(new Error('KV failed'));

            const result = await healthMonitor.performHealthCheck(mockEnv);

            expect(result.status).toBe('unhealthy');
            expect(result.checks.kvStorage.status).toBe('unhealthy');
            expect(result.checks.kvStorage.message).toContain('KV storage failed');
        });

        it('should detect circuit breaker open state', async () => {
            mockCircuitBreaker.getState.mockReturnValue({
                state: 'OPEN',
                failureCount: 5,
                lastFailureTime: Date.now(),
                nextAttemptTime: Date.now() + 30000,
                successCount: 0,
            });

            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            const result = await healthMonitor.performHealthCheck(mockEnv);

            expect(result.status).toBe('degraded');
            expect(result.checks.upstreamApi.status).toBe('degraded');
            expect(result.checks.circuitBreaker.status).toBe('degraded');
        });

        it('should detect performance alerts', async () => {
            mockPerformanceMonitor.checkPerformanceAlerts.mockReturnValue([
                'High error rate: 10.5%',
                'Low cache hit rate: 45.2%'
            ]);

            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            const result = await healthMonitor.performHealthCheck(mockEnv);

            expect(result.status).toBe('degraded');
            expect(result.checks.performance.status).toBe('degraded');
            expect(result.alerts).toHaveLength(2);
        });
    });

    describe('getOperationalMetrics', () => {
        it('should return comprehensive operational metrics', async () => {
            const metrics = await healthMonitor.getOperationalMetrics(mockEnv);

            expect(metrics.cacheMetrics.tokenCache.hitRate).toBe(85);
            expect(metrics.cacheMetrics.tokenCache.refreshCount).toBe(3);
            expect(metrics.upstreamMetrics.responseTime.average).toBe(500);
            expect(metrics.upstreamMetrics.circuitBreakerState).toBe('CLOSED');
            expect(metrics.systemMetrics.activeConnections).toBe(2);
            expect(metrics.systemMetrics.uptimeSeconds).toBeGreaterThanOrEqual(0);
        });
    });

    describe('createHealthCheckResponse', () => {
        it('should create healthy response with basic info', async () => {
            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            const response = await healthMonitor.createHealthCheckResponse(mockEnv, false);

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            
            const body = await response.json();
            expect(body.status).toBe('healthy');
            expect(body.timestamp).toBeDefined();
            expect(body.uptime).toBeDefined();
            expect(body.checks).toBeUndefined(); // Basic response doesn't include checks
        });

        it('should create detailed response with all checks', async () => {
            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            const response = await healthMonitor.createHealthCheckResponse(mockEnv, true);

            expect(response.status).toBe(200);
            
            const body = await response.json();
            expect(body.status).toBe('healthy');
            expect(body.checks).toBeDefined();
            expect(body.checks.authentication).toBeDefined();
            expect(body.checks.kvStorage).toBeDefined();
            expect(body.checks.upstreamApi).toBeDefined();
            expect(body.checks.circuitBreaker).toBeDefined();
            expect(body.checks.performance).toBeDefined();
            expect(body.metrics).toBeDefined();
        });

        it('should return 503 for unhealthy system', async () => {
            mockAuthManager.getAccessToken.mockRejectedValue(new Error('Auth failed'));

            const response = await healthMonitor.createHealthCheckResponse(mockEnv, false);

            expect(response.status).toBe(503);
            
            const body = await response.json();
            expect(body.status).toBe('unhealthy');
        });

        it('should handle health check system failures', async () => {
            // Mock a system failure
            mockMetricsCollector.getMetricsSnapshot.mockImplementation(() => {
                throw new Error('System failure');
            });

            const response = await healthMonitor.createHealthCheckResponse(mockEnv, false);

            expect(response.status).toBe(503);
            expect(mockConsole.error).toHaveBeenCalledWith('Health check failed:', expect.any(Error));
            
            const body = await response.json();
            expect(body.status).toBe('unhealthy');
            expect(body.error).toBe('Health check system failure');
        });
    });

    describe('createMetricsResponse', () => {
        it('should create JSON metrics response', async () => {
            const response = await healthMonitor.createMetricsResponse(mockEnv, 'json');

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            
            const body = await response.json();
            expect(body.operational).toBeDefined();
            expect(body.performance).toBeDefined();
            expect(body.timestamp).toBeDefined();
        });

        it('should create Prometheus metrics response', async () => {
            mockMetricsCollector.exportMetrics.mockReturnValue('# Prometheus metrics\ngemini_proxy_total_requests 100\n');

            const response = await healthMonitor.createMetricsResponse(mockEnv, 'prometheus');

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('text/plain; version=0.0.4');
            
            const body = await response.text();
            expect(body).toContain('gemini_proxy_total_requests');
        });

        it('should handle metrics collection failures', async () => {
            mockMetricsCollector.getMetricsSnapshot.mockImplementation(() => {
                throw new Error('Metrics failure');
            });

            const response = await healthMonitor.createMetricsResponse(mockEnv, 'json');

            expect(response.status).toBe(500);
            expect(mockConsole.error).toHaveBeenCalledWith('Metrics collection failed:', expect.any(Error));
            
            const body = await response.json();
            expect(body.error).toBe('Metrics collection failure');
        });
    });

    describe('getLastHealthCheck', () => {
        it('should return null initially', () => {
            const result = healthMonitor.getLastHealthCheck();
            expect(result).toBeNull();
        });

        it('should return last health check result after performing check', async () => {
            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            await healthMonitor.performHealthCheck(mockEnv);
            const result = healthMonitor.getLastHealthCheck();
            
            expect(result).not.toBeNull();
            expect(result?.status).toBe('healthy');
        });
    });

    describe('isHealthy', () => {
        it('should return false initially', () => {
            expect(healthMonitor.isHealthy()).toBe(false);
        });

        it('should return true after healthy check', async () => {
            // Setup KV mock for successful test - need to return the same value that was put
            let storedValue: string | null = null;
            mockEnv.GEMINI_CREDS_KV.put.mockImplementation((key, value) => {
                if (key === 'health-check-test') {
                    storedValue = value;
                }
                return Promise.resolve(undefined);
            });
            mockEnv.GEMINI_CREDS_KV.get.mockImplementation((key) => {
                if (key === 'health-check-test') {
                    return Promise.resolve(storedValue);
                }
                return Promise.resolve(null);
            });
            mockEnv.GEMINI_CREDS_KV.delete.mockResolvedValue(undefined);

            await healthMonitor.performHealthCheck(mockEnv);
            expect(healthMonitor.isHealthy()).toBe(true);
        });

        it('should return false after unhealthy check', async () => {
            mockAuthManager.getAccessToken.mockRejectedValue(new Error('Auth failed'));

            await healthMonitor.performHealthCheck(mockEnv);
            expect(healthMonitor.isHealthy()).toBe(false);
        });
    });
});