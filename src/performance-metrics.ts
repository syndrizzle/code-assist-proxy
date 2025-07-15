import { PerformanceMetrics, RequestContext, SystemMetrics, Env } from "./types";

export interface MetricsSnapshot {
    timestamp: number;
    totalRequests: number;
    activeRequests: number;
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    errorRate: number;
    cacheHitRate: number;
    tokenRefreshCount: number;
    circuitBreakerTrips: number;
    memoryUsage?: number;
}

export interface RequestMetricsData {
    requestId: string;
    timestamp: number;
    model: string;
    action: string;
    totalTime: number;
    authTime: number;
    transformTime: number;
    upstreamTime: number;
    isStreaming: boolean;
    cacheUsed: boolean;
    retryCount: number;
    errorOccurred: boolean;
    statusCode?: number;
}

export class PerformanceMetricsCollector {
    private static instance: PerformanceMetricsCollector;
    private recentRequests: RequestMetricsData[] = [];
    private systemMetrics: SystemMetrics = {
        activeRequests: 0,
        totalRequests: 0,
        errorRate: 0,
        averageResponseTime: 0,
        tokenRefreshCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
    };
    
    private readonly maxRecentRequests = 1000; // Keep last 1000 requests for calculations
    private readonly metricsRetentionMs = 5 * 60 * 1000; // 5 minutes
    private lastCleanup = Date.now();

    private constructor() {}

    public static getInstance(): PerformanceMetricsCollector {
        if (!PerformanceMetricsCollector.instance) {
            PerformanceMetricsCollector.instance = new PerformanceMetricsCollector();
        }
        return PerformanceMetricsCollector.instance;
    }

    /**
     * Record a completed request's metrics
     */
    public recordRequest(context: RequestContext, errorOccurred: boolean = false, statusCode?: number): void {
        const requestData: RequestMetricsData = {
            requestId: context.requestId,
            timestamp: Date.now(),
            model: context.model,
            action: context.action,
            totalTime: context.metrics.totalTime,
            authTime: context.metrics.authTime,
            transformTime: context.metrics.transformTime,
            upstreamTime: context.metrics.upstreamTime,
            isStreaming: context.isStreaming,
            cacheUsed: context.cacheUsed,
            retryCount: context.retryCount,
            errorOccurred,
            statusCode,
        };

        this.recentRequests.push(requestData);
        this.systemMetrics.totalRequests++;

        // Update cache metrics
        if (context.cacheUsed) {
            this.systemMetrics.cacheHitCount++;
        } else {
            this.systemMetrics.cacheMissCount++;
        }

        // Cleanup old requests periodically
        this.cleanupOldMetrics();
        
        // Recalculate derived metrics
        this.updateDerivedMetrics();
    }

    /**
     * Record token refresh event
     */
    public recordTokenRefresh(): void {
        this.systemMetrics.tokenRefreshCount++;
    }

    /**
     * Update active request count
     */
    public updateActiveRequests(count: number): void {
        this.systemMetrics.activeRequests = count;
    }

    /**
     * Get current system metrics
     */
    public getSystemMetrics(): SystemMetrics {
        return { ...this.systemMetrics };
    }

    /**
     * Get detailed metrics snapshot
     */
    public getMetricsSnapshot(): MetricsSnapshot {
        const recentRequestsInWindow = this.getRecentRequests(this.metricsRetentionMs);
        const responseTimes = recentRequestsInWindow.map(r => r.totalTime).sort((a, b) => a - b);
        
        return {
            timestamp: Date.now(),
            totalRequests: this.systemMetrics.totalRequests,
            activeRequests: this.systemMetrics.activeRequests,
            averageResponseTime: this.systemMetrics.averageResponseTime,
            p95ResponseTime: this.calculatePercentile(responseTimes, 95),
            p99ResponseTime: this.calculatePercentile(responseTimes, 99),
            errorRate: this.systemMetrics.errorRate,
            cacheHitRate: this.calculateCacheHitRate(),
            tokenRefreshCount: this.systemMetrics.tokenRefreshCount,
            circuitBreakerTrips: 0, // Would be updated by circuit breaker
            memoryUsage: this.getMemoryUsage(),
        };
    }

    /**
     * Get performance breakdown by model
     */
    public getModelPerformanceBreakdown(): Record<string, {
        requestCount: number;
        averageResponseTime: number;
        errorRate: number;
        cacheHitRate: number;
    }> {
        const recentRequests = this.getRecentRequests(this.metricsRetentionMs);
        const modelStats: Record<string, any> = {};

        for (const request of recentRequests) {
            if (!modelStats[request.model]) {
                modelStats[request.model] = {
                    requests: [],
                    errors: 0,
                    cacheHits: 0,
                };
            }

            modelStats[request.model].requests.push(request);
            if (request.errorOccurred) {
                modelStats[request.model].errors++;
            }
            if (request.cacheUsed) {
                modelStats[request.model].cacheHits++;
            }
        }

        const result: Record<string, any> = {};
        for (const [model, stats] of Object.entries(modelStats)) {
            const requests = stats.requests;
            const totalTime = requests.reduce((sum: number, r: RequestMetricsData) => sum + r.totalTime, 0);
            
            result[model] = {
                requestCount: requests.length,
                averageResponseTime: requests.length > 0 ? totalTime / requests.length : 0,
                errorRate: requests.length > 0 ? (stats.errors / requests.length) * 100 : 0,
                cacheHitRate: requests.length > 0 ? (stats.cacheHits / requests.length) * 100 : 0,
            };
        }

        return result;
    }

    /**
     * Get slow requests (above threshold)
     */
    public getSlowRequests(thresholdMs: number = 5000): RequestMetricsData[] {
        return this.getRecentRequests(this.metricsRetentionMs)
            .filter(r => r.totalTime > thresholdMs)
            .sort((a, b) => b.totalTime - a.totalTime)
            .slice(0, 50); // Return top 50 slowest
    }

    /**
     * Export metrics for external monitoring systems
     */
    public exportMetrics(format: 'json' | 'prometheus' = 'json'): string {
        if (format === 'prometheus') {
            return this.exportPrometheusMetrics();
        }
        
        return JSON.stringify({
            snapshot: this.getMetricsSnapshot(),
            systemMetrics: this.getSystemMetrics(),
            modelBreakdown: this.getModelPerformanceBreakdown(),
            slowRequests: this.getSlowRequests(),
        }, null, 2);
    }

    private getRecentRequests(windowMs: number): RequestMetricsData[] {
        const cutoff = Date.now() - windowMs;
        return this.recentRequests.filter(r => r.timestamp > cutoff);
    }

    private updateDerivedMetrics(): void {
        const recentRequests = this.getRecentRequests(this.metricsRetentionMs);
        
        if (recentRequests.length > 0) {
            // Calculate average response time
            const totalTime = recentRequests.reduce((sum, r) => sum + r.totalTime, 0);
            this.systemMetrics.averageResponseTime = totalTime / recentRequests.length;

            // Calculate error rate
            const errorCount = recentRequests.filter(r => r.errorOccurred).length;
            this.systemMetrics.errorRate = (errorCount / recentRequests.length) * 100;
        }
    }

    private calculatePercentile(sortedValues: number[], percentile: number): number {
        if (sortedValues.length === 0) return 0;
        
        const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
    }

    private calculateCacheHitRate(): number {
        const totalCacheOperations = this.systemMetrics.cacheHitCount + this.systemMetrics.cacheMissCount;
        return totalCacheOperations > 0 ? (this.systemMetrics.cacheHitCount / totalCacheOperations) * 100 : 0;
    }

    private getMemoryUsage(): number | undefined {
        // In Cloudflare Workers, memory usage isn't directly accessible
        // This would be implemented differently in other environments
        return undefined;
    }

    private cleanupOldMetrics(): void {
        const now = Date.now();
        
        // Only cleanup every minute to avoid excessive processing
        if (now - this.lastCleanup < 60000) return;
        
        const cutoff = now - this.metricsRetentionMs;
        this.recentRequests = this.recentRequests.filter(r => r.timestamp > cutoff);
        
        // Also limit total size
        if (this.recentRequests.length > this.maxRecentRequests) {
            this.recentRequests = this.recentRequests.slice(-this.maxRecentRequests);
        }
        
        this.lastCleanup = now;
    }

    private exportPrometheusMetrics(): string {
        const snapshot = this.getMetricsSnapshot();
        const modelBreakdown = this.getModelPerformanceBreakdown();
        
        let metrics = '';
        
        // System metrics
        metrics += `# HELP gemini_proxy_total_requests Total number of requests processed\n`;
        metrics += `# TYPE gemini_proxy_total_requests counter\n`;
        metrics += `gemini_proxy_total_requests ${snapshot.totalRequests}\n\n`;
        
        metrics += `# HELP gemini_proxy_active_requests Current number of active requests\n`;
        metrics += `# TYPE gemini_proxy_active_requests gauge\n`;
        metrics += `gemini_proxy_active_requests ${snapshot.activeRequests}\n\n`;
        
        metrics += `# HELP gemini_proxy_response_time_ms Response time in milliseconds\n`;
        metrics += `# TYPE gemini_proxy_response_time_ms histogram\n`;
        metrics += `gemini_proxy_response_time_ms_sum ${snapshot.averageResponseTime * snapshot.totalRequests}\n`;
        metrics += `gemini_proxy_response_time_ms_count ${snapshot.totalRequests}\n\n`;
        
        metrics += `# HELP gemini_proxy_error_rate Error rate percentage\n`;
        metrics += `# TYPE gemini_proxy_error_rate gauge\n`;
        metrics += `gemini_proxy_error_rate ${snapshot.errorRate}\n\n`;
        
        metrics += `# HELP gemini_proxy_cache_hit_rate Cache hit rate percentage\n`;
        metrics += `# TYPE gemini_proxy_cache_hit_rate gauge\n`;
        metrics += `gemini_proxy_cache_hit_rate ${snapshot.cacheHitRate}\n\n`;
        
        // Per-model metrics
        for (const [model, stats] of Object.entries(modelBreakdown)) {
            metrics += `gemini_proxy_model_requests{model="${model}"} ${stats.requestCount}\n`;
            metrics += `gemini_proxy_model_avg_response_time{model="${model}"} ${stats.averageResponseTime}\n`;
            metrics += `gemini_proxy_model_error_rate{model="${model}"} ${stats.errorRate}\n`;
        }
        
        return metrics;
    }
}

/**
 * Utility class for performance monitoring and alerting
 */
export class PerformanceMonitor {
    private static instance: PerformanceMonitor;
    private metricsCollector: PerformanceMetricsCollector;
    private alertThresholds = {
        slowRequestMs: 5000,
        highErrorRate: 5.0, // 5%
        lowCacheHitRate: 50.0, // 50%
        highActiveRequests: 100,
    };

    private constructor() {
        this.metricsCollector = PerformanceMetricsCollector.getInstance();
    }

    public static getInstance(): PerformanceMonitor {
        if (!PerformanceMonitor.instance) {
            PerformanceMonitor.instance = new PerformanceMonitor();
        }
        return PerformanceMonitor.instance;
    }

    /**
     * Check for performance issues and return alerts
     */
    public checkPerformanceAlerts(): string[] {
        const alerts: string[] = [];
        const snapshot = this.metricsCollector.getMetricsSnapshot();
        
        // Check error rate
        if (snapshot.errorRate > this.alertThresholds.highErrorRate) {
            alerts.push(`High error rate: ${snapshot.errorRate.toFixed(2)}%`);
        }
        
        // Check cache hit rate
        if (snapshot.cacheHitRate < this.alertThresholds.lowCacheHitRate) {
            alerts.push(`Low cache hit rate: ${snapshot.cacheHitRate.toFixed(2)}%`);
        }
        
        // Check active requests
        if (snapshot.activeRequests > this.alertThresholds.highActiveRequests) {
            alerts.push(`High active request count: ${snapshot.activeRequests}`);
        }
        
        // Check for slow requests
        const slowRequests = this.metricsCollector.getSlowRequests(this.alertThresholds.slowRequestMs);
        if (slowRequests.length > 0) {
            alerts.push(`${slowRequests.length} slow requests detected (>${this.alertThresholds.slowRequestMs}ms)`);
        }
        
        return alerts;
    }

    /**
     * Log performance summary
     */
    public logPerformanceSummary(): void {
        const snapshot = this.metricsCollector.getMetricsSnapshot();
        const modelBreakdown = this.metricsCollector.getModelPerformanceBreakdown();
        
        console.log('=== Performance Summary ===');
        console.log(`Total Requests: ${snapshot.totalRequests}`);
        console.log(`Active Requests: ${snapshot.activeRequests}`);
        console.log(`Average Response Time: ${snapshot.averageResponseTime.toFixed(2)}ms`);
        console.log(`P95 Response Time: ${snapshot.p95ResponseTime.toFixed(2)}ms`);
        console.log(`P99 Response Time: ${snapshot.p99ResponseTime.toFixed(2)}ms`);
        console.log(`Error Rate: ${snapshot.errorRate.toFixed(2)}%`);
        console.log(`Cache Hit Rate: ${snapshot.cacheHitRate.toFixed(2)}%`);
        console.log(`Token Refreshes: ${snapshot.tokenRefreshCount}`);
        
        console.log('\n=== Model Performance ===');
        for (const [model, stats] of Object.entries(modelBreakdown)) {
            console.log(`${model}: ${stats.requestCount} requests, ${stats.averageResponseTime.toFixed(2)}ms avg, ${stats.errorRate.toFixed(2)}% errors`);
        }
        
        const alerts = this.checkPerformanceAlerts();
        if (alerts.length > 0) {
            console.warn('\n=== Performance Alerts ===');
            alerts.forEach(alert => console.warn(`⚠️  ${alert}`));
        }
    }
}