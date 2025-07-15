import { RequestContext, PerformanceMetrics, RequestTimings } from "./types";
import { PerformanceMetricsCollector } from "./performance-metrics";

export class RequestContextManager {
    private static activeRequests = new Map<string, RequestContext>();

    /**
     * Generate a unique request ID
     */
    public static generateRequestId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `req_${timestamp}_${random}`;
    }

    /**
     * Create a new request context
     */
    public static createContext(
        model: string,
        action: string,
        isStreaming: boolean,
        clientIP?: string,
        userAgent?: string
    ): RequestContext {
        const requestId = this.generateRequestId();
        const startTime = Date.now();

        const context: RequestContext = {
            requestId,
            startTime,
            model,
            action,
            isStreaming,
            clientIP,
            userAgent,
            metrics: {
                requestStartTime: startTime,
                authTime: 0,
                transformTime: 0,
                upstreamTime: 0,
                totalTime: 0,
            },
            timings: {
                start: startTime,
            },
            retryCount: 0,
            cacheUsed: false,
        };

        this.activeRequests.set(requestId, context);
        return context;
    }

    /**
     * Start timing for a specific stage
     */
    public static startTiming(context: RequestContext, stage: keyof RequestTimings): void {
        const now = Date.now();
        switch (stage) {
            case 'authStart':
                context.timings.authStart = now;
                break;
            case 'transformStart':
                context.timings.transformStart = now;
                break;
            case 'upstreamStart':
                context.timings.upstreamStart = now;
                break;
        }
    }

    /**
     * End timing for a specific stage and update metrics
     */
    public static endTiming(context: RequestContext, stage: keyof RequestTimings): void {
        const now = Date.now();
        
        switch (stage) {
            case 'authEnd':
                context.timings.authEnd = now;
                if (context.timings.authStart) {
                    context.metrics.authTime = now - context.timings.authStart;
                }
                break;
            case 'transformEnd':
                context.timings.transformEnd = now;
                if (context.timings.transformStart) {
                    context.metrics.transformTime = now - context.timings.transformStart;
                }
                break;
            case 'upstreamEnd':
                context.timings.upstreamEnd = now;
                if (context.timings.upstreamStart) {
                    context.metrics.upstreamTime = now - context.timings.upstreamStart;
                }
                break;
            case 'end':
                context.timings.end = now;
                context.metrics.totalTime = now - context.startTime;
                break;
        }
    }

    /**
     * Mark cache usage for the request
     */
    public static markCacheUsed(context: RequestContext, cacheType: 'token' | 'project'): void {
        context.cacheUsed = true;
        console.log(`[${context.requestId}] Cache hit for ${cacheType}`);
    }

    /**
     * Increment retry count
     */
    public static incrementRetry(context: RequestContext): void {
        context.retryCount++;
        console.log(`[${context.requestId}] Retry attempt ${context.retryCount}`);
    }

    /**
     * Log performance metrics for the request
     */
    public static logMetrics(context: RequestContext): void {
        const { requestId, model, action, isStreaming, metrics, retryCount, cacheUsed } = context;
        
        console.log(`[${requestId}] Request completed:`, {
            model,
            action,
            isStreaming,
            totalTime: `${metrics.totalTime}ms`,
            authTime: `${metrics.authTime}ms`,
            transformTime: `${metrics.transformTime}ms`,
            upstreamTime: `${metrics.upstreamTime}ms`,
            retryCount,
            cacheUsed,
        });

        // Log performance warning if request is slow
        if (metrics.totalTime > 5000) {
            console.warn(`[${requestId}] Slow request detected: ${metrics.totalTime}ms`);
        }
    }

    /**
     * Complete and clean up request context
     */
    public static completeRequest(context: RequestContext, errorOccurred: boolean = false, statusCode?: number): void {
        this.endTiming(context, 'end');
        this.logMetrics(context);
        
        // Record metrics in the performance collector
        const metricsCollector = PerformanceMetricsCollector.getInstance();
        metricsCollector.recordRequest(context, errorOccurred, statusCode);
        metricsCollector.updateActiveRequests(this.activeRequests.size - 1);
        
        this.activeRequests.delete(context.requestId);
    }

    /**
     * Get active request count
     */
    public static getActiveRequestCount(): number {
        return this.activeRequests.size;
    }

    /**
     * Get all active request contexts (for monitoring)
     */
    public static getActiveRequests(): RequestContext[] {
        return Array.from(this.activeRequests.values());
    }

    /**
     * Clean up stale requests (older than 5 minutes)
     */
    public static cleanupStaleRequests(): void {
        const now = Date.now();
        const staleThreshold = 5 * 60 * 1000; // 5 minutes

        for (const [requestId, context] of this.activeRequests.entries()) {
            if (now - context.startTime > staleThreshold) {
                console.warn(`[${requestId}] Cleaning up stale request`);
                this.activeRequests.delete(requestId);
            }
        }
    }

    /**
     * Get performance statistics across all recent requests
     */
    public static getPerformanceStats(): {
        activeRequests: number;
        averageResponseTime: number;
        cacheHitRate: number;
        retryRate: number;
    } {
        const activeRequests = this.getActiveRequestCount();
        
        // For now, return basic stats - in a real implementation,
        // you'd want to maintain a rolling window of completed requests
        return {
            activeRequests,
            averageResponseTime: 0, // Would calculate from completed requests
            cacheHitRate: 0, // Would calculate from completed requests
            retryRate: 0, // Would calculate from completed requests
        };
    }
}