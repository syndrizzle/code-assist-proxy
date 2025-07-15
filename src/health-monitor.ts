import { Env } from "./types";
import { PerformanceMetricsCollector, PerformanceMonitor } from "./performance-metrics";
import { AuthManager } from "./auth";
import { ConnectionPool } from "./connection-pool";
import { CircuitBreaker } from "./circuit-breaker";
import { ProjectCacheManager } from "./project-cache";

export interface HealthCheckResult {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: number;
    version: string;
    uptime: number;
    checks: {
        authentication: HealthCheckStatus;
        kvStorage: HealthCheckStatus;
        upstreamApi: HealthCheckStatus;
        circuitBreaker: HealthCheckStatus;
        performance: HealthCheckStatus;
    };
    metrics: {
        totalRequests: number;
        activeRequests: number;
        errorRate: number;
        averageResponseTime: number;
        cacheHitRate: number;
        tokenRefreshCount: number;
    };
    alerts: string[];
}

export interface HealthCheckStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    message: string;
    responseTime?: number;
    lastChecked: number;
}

export interface OperationalMetrics {
    cacheMetrics: {
        tokenCache: {
            hitRate: number;
            missRate: number;
            refreshCount: number;
            lastRefresh: number;
        };
        projectCache: {
            hitRate: number;
            missRate: number;
            size: number;
            lastUpdate: number;
        };
    };
    upstreamMetrics: {
        responseTime: {
            average: number;
            p95: number;
            p99: number;
        };
        errorRate: number;
        requestCount: number;
        circuitBreakerState: string;
    };
    systemMetrics: {
        memoryUsage?: number;
        activeConnections: number;
        requestsPerSecond: number;
        uptimeSeconds: number;
    };
}

export class HealthMonitor {
    private static instance: HealthMonitor;
    private startTime: number = Date.now();
    private lastHealthCheck: HealthCheckResult | null = null;
    private healthCheckInterval: number = 30000; // 30 seconds
    private metricsCollector: PerformanceMetricsCollector;
    private performanceMonitor: PerformanceMonitor;

    private constructor() {
        this.metricsCollector = PerformanceMetricsCollector.getInstance();
        this.performanceMonitor = PerformanceMonitor.getInstance();
    }

    public static getInstance(): HealthMonitor {
        if (!HealthMonitor.instance) {
            HealthMonitor.instance = new HealthMonitor();
        }
        return HealthMonitor.instance;
    }

    /**
     * Perform comprehensive health check
     */
    public async performHealthCheck(env: Env): Promise<HealthCheckResult> {
        const startTime = Date.now();
        const checks = await this.runHealthChecks(env);
        
        // Determine overall health status
        const overallStatus = this.determineOverallStatus(checks);
        
        // Get current metrics
        const snapshot = this.metricsCollector.getMetricsSnapshot();
        const alerts = this.performanceMonitor.checkPerformanceAlerts();

        const result: HealthCheckResult = {
            status: overallStatus,
            timestamp: Date.now(),
            version: '1.0.0', // Would be injected from build process
            uptime: Date.now() - this.startTime,
            checks,
            metrics: {
                totalRequests: snapshot.totalRequests,
                activeRequests: snapshot.activeRequests,
                errorRate: snapshot.errorRate,
                averageResponseTime: snapshot.averageResponseTime,
                cacheHitRate: snapshot.cacheHitRate,
                tokenRefreshCount: snapshot.tokenRefreshCount,
            },
            alerts,
        };

        this.lastHealthCheck = result;
        return result;
    }

    /**
     * Get operational metrics for monitoring systems
     */
    public async getOperationalMetrics(env: Env): Promise<OperationalMetrics> {
        const snapshot = this.metricsCollector.getMetricsSnapshot();
        const systemMetrics = this.metricsCollector.getSystemMetrics();
        
        // Get auth manager cache metrics
        const authManager = AuthManager.getInstance(env);
        const authCacheMetrics = authManager.getCacheMetrics();
        
        // Get circuit breaker state
        const circuitBreaker = CircuitBreaker.getInstance('upstream-api', {
            failureThreshold: 5,
            timeoutMs: 30000,
            halfOpenMaxCalls: 3,
            resetTimeoutMs: 60000
        });
        const circuitBreakerState = circuitBreaker.getState();
        
        // Get connection pool metrics
        const connectionPool = ConnectionPool.getInstance();
        const connectionMetrics = connectionPool.getMetrics();

        return {
            cacheMetrics: {
                tokenCache: {
                    hitRate: snapshot.cacheHitRate,
                    missRate: 100 - snapshot.cacheHitRate,
                    refreshCount: authCacheMetrics?.refreshCount || 0,
                    lastRefresh: authCacheMetrics?.lastUsed || 0,
                },
                projectCache: {
                    hitRate: 0, // Would be implemented in ProjectCacheManager
                    missRate: 0,
                    size: 0,
                    lastUpdate: 0,
                },
            },
            upstreamMetrics: {
                responseTime: {
                    average: snapshot.averageResponseTime,
                    p95: snapshot.p95ResponseTime,
                    p99: snapshot.p99ResponseTime,
                },
                errorRate: snapshot.errorRate,
                requestCount: snapshot.totalRequests,
                circuitBreakerState: circuitBreakerState.state,
            },
            systemMetrics: {
                memoryUsage: snapshot.memoryUsage,
                activeConnections: connectionMetrics.activeConnections,
                requestsPerSecond: this.calculateRequestsPerSecond(),
                uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            },
        };
    }

    /**
     * Create health check endpoint response
     */
    public async createHealthCheckResponse(env: Env, detailed: boolean = false): Promise<Response> {
        try {
            const healthCheck = await this.performHealthCheck(env);
            
            const responseBody = detailed ? healthCheck : {
                status: healthCheck.status,
                timestamp: healthCheck.timestamp,
                uptime: healthCheck.uptime,
            };

            const statusCode = healthCheck.status === 'healthy' ? 200 : 
                              healthCheck.status === 'degraded' ? 200 : 503;

            return new Response(JSON.stringify(responseBody, null, 2), {
                status: statusCode,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'X-Health-Check-Version': '1.0',
                },
            });
        } catch (error) {
            console.error('Health check failed:', error);
            
            return new Response(JSON.stringify({
                status: 'unhealthy',
                timestamp: Date.now(),
                error: 'Health check system failure',
            }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                },
            });
        }
    }

    /**
     * Create metrics endpoint response
     */
    public async createMetricsResponse(env: Env, format: 'json' | 'prometheus' = 'json'): Promise<Response> {
        try {
            if (format === 'prometheus') {
                const prometheusMetrics = this.metricsCollector.exportMetrics('prometheus');
                return new Response(prometheusMetrics, {
                    headers: {
                        'Content-Type': 'text/plain; version=0.0.4',
                        'Cache-Control': 'no-cache',
                    },
                });
            }

            const operationalMetrics = await this.getOperationalMetrics(env);
            const performanceMetrics = this.metricsCollector.exportMetrics('json');
            
            const combinedMetrics = {
                operational: operationalMetrics,
                performance: JSON.parse(performanceMetrics),
                timestamp: Date.now(),
            };

            return new Response(JSON.stringify(combinedMetrics, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                },
            });
        } catch (error) {
            console.error('Metrics collection failed:', error);
            
            return new Response(JSON.stringify({
                error: 'Metrics collection failure',
                timestamp: Date.now(),
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                },
            });
        }
    }

    private async runHealthChecks(env: Env): Promise<HealthCheckResult['checks']> {
        const checks = {
            authentication: await this.checkAuthentication(env),
            kvStorage: await this.checkKVStorage(env),
            upstreamApi: await this.checkUpstreamApi(env),
            circuitBreaker: await this.checkCircuitBreaker(),
            performance: await this.checkPerformance(),
        };

        return checks;
    }

    private async checkAuthentication(env: Env): Promise<HealthCheckStatus> {
        const startTime = Date.now();
        
        try {
            const authManager = AuthManager.getInstance(env);
            await authManager.initialize();
            
            // Try to get access token (this will validate the auth flow)
            const token = await authManager.getAccessToken();
            
            if (!token || token.length < 10) {
                return {
                    status: 'unhealthy',
                    message: 'Invalid or empty access token',
                    responseTime: Date.now() - startTime,
                    lastChecked: Date.now(),
                };
            }

            return {
                status: 'healthy',
                message: 'Authentication system operational',
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        } catch (error: any) {
            return {
                status: 'unhealthy',
                message: `Authentication failed: ${error.message}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        }
    }

    private async checkKVStorage(env: Env): Promise<HealthCheckStatus> {
        const startTime = Date.now();
        
        try {
            // Test KV connectivity with a simple read/write
            const testKey = 'health-check-test';
            const testValue = Date.now().toString();
            
            await env.GEMINI_CREDS_KV.put(testKey, testValue, { expirationTtl: 60 });
            const retrieved = await env.GEMINI_CREDS_KV.get(testKey);
            
            if (retrieved !== testValue) {
                return {
                    status: 'unhealthy',
                    message: 'KV storage read/write mismatch',
                    responseTime: Date.now() - startTime,
                    lastChecked: Date.now(),
                };
            }

            // Clean up test data
            await env.GEMINI_CREDS_KV.delete(testKey);

            return {
                status: 'healthy',
                message: 'KV storage operational',
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        } catch (error: any) {
            return {
                status: 'unhealthy',
                message: `KV storage failed: ${error.message}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        }
    }

    private async checkUpstreamApi(env: Env): Promise<HealthCheckStatus> {
        const startTime = Date.now();
        
        try {
            const circuitBreaker = CircuitBreaker.getInstance('upstream-api', {
                failureThreshold: 5,
                timeoutMs: 30000,
                halfOpenMaxCalls: 3,
                resetTimeoutMs: 60000
            });
            const state = circuitBreaker.getState();
            
            if (state.state === 'OPEN') {
                return {
                    status: 'degraded',
                    message: `Circuit breaker is OPEN (${state.failureCount} failures)`,
                    responseTime: Date.now() - startTime,
                    lastChecked: Date.now(),
                };
            }

            // For now, we'll check circuit breaker state as a proxy for upstream health
            // In a full implementation, you might want to make a lightweight test call
            return {
                status: state.state === 'CLOSED' ? 'healthy' : 'degraded',
                message: `Upstream API circuit breaker: ${state.state}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        } catch (error: any) {
            return {
                status: 'unhealthy',
                message: `Upstream API check failed: ${error.message}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        }
    }

    private async checkCircuitBreaker(): Promise<HealthCheckStatus> {
        const startTime = Date.now();
        
        try {
            const circuitBreaker = CircuitBreaker.getInstance('upstream-api', {
                failureThreshold: 5,
                timeoutMs: 30000,
                halfOpenMaxCalls: 3,
                resetTimeoutMs: 60000
            });
            const state = circuitBreaker.getState();
            
            let status: 'healthy' | 'degraded' | 'unhealthy';
            let message: string;
            
            switch (state.state) {
                case 'CLOSED':
                    status = 'healthy';
                    message = 'Circuit breaker closed, system operational';
                    break;
                case 'HALF_OPEN':
                    status = 'degraded';
                    message = 'Circuit breaker half-open, testing recovery';
                    break;
                case 'OPEN':
                    status = 'degraded';
                    message = `Circuit breaker open, ${state.failureCount} failures detected`;
                    break;
                default:
                    status = 'unhealthy';
                    message = 'Circuit breaker in unknown state';
            }

            return {
                status,
                message,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        } catch (error: any) {
            return {
                status: 'unhealthy',
                message: `Circuit breaker check failed: ${error.message}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        }
    }

    private async checkPerformance(): Promise<HealthCheckStatus> {
        const startTime = Date.now();
        
        try {
            const alerts = this.performanceMonitor.checkPerformanceAlerts();
            const snapshot = this.metricsCollector.getMetricsSnapshot();
            
            if (alerts.length === 0) {
                return {
                    status: 'healthy',
                    message: 'Performance metrics within normal ranges',
                    responseTime: Date.now() - startTime,
                    lastChecked: Date.now(),
                };
            }

            // Determine severity based on alert types
            const criticalAlerts = alerts.filter(alert => 
                alert.includes('High error rate') || 
                alert.includes('High active request count')
            );

            const status = criticalAlerts.length > 0 ? 'degraded' : 'healthy';
            const message = `${alerts.length} performance alerts: ${alerts.slice(0, 2).join(', ')}${alerts.length > 2 ? '...' : ''}`;

            return {
                status,
                message,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        } catch (error: any) {
            return {
                status: 'unhealthy',
                message: `Performance check failed: ${error.message}`,
                responseTime: Date.now() - startTime,
                lastChecked: Date.now(),
            };
        }
    }

    private determineOverallStatus(checks: HealthCheckResult['checks']): 'healthy' | 'degraded' | 'unhealthy' {
        const statuses = Object.values(checks).map(check => check.status);
        
        if (statuses.includes('unhealthy')) {
            return 'unhealthy';
        }
        
        if (statuses.includes('degraded')) {
            return 'degraded';
        }
        
        return 'healthy';
    }

    private calculateRequestsPerSecond(): number {
        const snapshot = this.metricsCollector.getMetricsSnapshot();
        const uptimeSeconds = (Date.now() - this.startTime) / 1000;
        
        return uptimeSeconds > 0 ? snapshot.totalRequests / uptimeSeconds : 0;
    }

    /**
     * Get the last health check result (cached)
     */
    public getLastHealthCheck(): HealthCheckResult | null {
        return this.lastHealthCheck;
    }

    /**
     * Check if system is healthy based on last health check
     */
    public isHealthy(): boolean {
        return this.lastHealthCheck?.status === 'healthy';
    }
}