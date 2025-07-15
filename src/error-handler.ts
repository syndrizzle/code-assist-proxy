import { ErrorMetrics } from "./types";

export enum ErrorType {
    CLIENT_ERROR = 'CLIENT_ERROR',
    AUTH_ERROR = 'AUTH_ERROR', 
    UPSTREAM_ERROR = 'UPSTREAM_ERROR',
    SYSTEM_ERROR = 'SYSTEM_ERROR'
}

export interface ErrorClassification {
    type: ErrorType;
    statusCode: number;
    message: string;
    isRetryable: boolean;
    shouldClearCache: boolean;
}

export class ErrorHandler {
    private static errorMetrics: ErrorMetrics[] = [];
    private static readonly MAX_ERROR_HISTORY = 1000;

    public static classifyError(error: any, statusCode?: number, requestId?: string): ErrorClassification {
        // Handle Response objects
        if (error instanceof Response || (error && typeof error.status === 'number')) {
            const status = error.status || statusCode || 500;
            return this.classifyHttpError(status, error.statusText || 'Unknown error', requestId);
        }

        // Handle Error objects
        if (error instanceof Error) {
            return this.classifyErrorByMessage(error.message, statusCode || 500, requestId);
        }

        // Handle string errors
        if (typeof error === 'string') {
            return this.classifyErrorByMessage(error, statusCode || 500, requestId);
        }

        // Default system error
        return {
            type: ErrorType.SYSTEM_ERROR,
            statusCode: 500,
            message: 'Internal server error',
            isRetryable: false,
            shouldClearCache: false
        };
    }

    private static classifyHttpError(statusCode: number, statusText: string, requestId?: string): ErrorClassification {
        let type: ErrorType;
        let isRetryable = false;
        let shouldClearCache = false;
        let message = this.sanitizeErrorMessage(statusText);

        if (statusCode >= 400 && statusCode < 500) {
            if (statusCode === 401) {
                type = ErrorType.AUTH_ERROR;
                isRetryable = true;
                shouldClearCache = true;
                message = 'Authentication failed';
            } else if (statusCode === 429) {
                type = ErrorType.CLIENT_ERROR;
                isRetryable = true;
                message = 'Rate limit exceeded';
            } else {
                type = ErrorType.CLIENT_ERROR;
                message = this.getClientErrorMessage(statusCode);
            }
        } else if (statusCode >= 500) {
            type = ErrorType.UPSTREAM_ERROR;
            isRetryable = true;
            message = 'Upstream service error';
        } else {
            type = ErrorType.SYSTEM_ERROR;
            message = 'Unexpected response status';
        }

        this.recordError(type, statusCode, message, requestId || 'unknown');

        return {
            type,
            statusCode,
            message,
            isRetryable,
            shouldClearCache
        };
    }

    private static classifyErrorByMessage(errorMessage: string, statusCode: number, requestId?: string): ErrorClassification {
        const lowerMessage = errorMessage.toLowerCase();
        let type: ErrorType;
        let isRetryable = false;
        let shouldClearCache = false;
        let message = this.sanitizeErrorMessage(errorMessage);

        // Check status code first for more accurate classification
        if (statusCode >= 500) {
            type = ErrorType.UPSTREAM_ERROR;
            isRetryable = true;
            message = 'Upstream service error';
        } else if (statusCode === 401) {
            type = ErrorType.AUTH_ERROR;
            isRetryable = true;
            shouldClearCache = true;
            message = 'Authentication error';
        } else if (statusCode >= 400 && statusCode < 500) {
            type = ErrorType.CLIENT_ERROR;
            message = this.getClientErrorMessage(statusCode);
        } else if (lowerMessage.includes('token') || lowerMessage.includes('auth') || lowerMessage.includes('unauthorized')) {
            type = ErrorType.AUTH_ERROR;
            isRetryable = true;
            shouldClearCache = true;
            message = 'Authentication error';
        } else if (lowerMessage.includes('network') || lowerMessage.includes('timeout') || lowerMessage.includes('connection')) {
            type = ErrorType.UPSTREAM_ERROR;
            isRetryable = true;
            message = 'Network connectivity error';
        } else if (lowerMessage.includes('invalid') || lowerMessage.includes('malformed') || lowerMessage.includes('bad request')) {
            type = ErrorType.CLIENT_ERROR;
            message = 'Invalid request format';
        } else {
            type = ErrorType.SYSTEM_ERROR;
            message = 'Internal processing error';
        }

        this.recordError(type, statusCode, message, requestId || 'unknown');

        return {
            type,
            statusCode,
            message,
            isRetryable,
            shouldClearCache
        };
    }

    private static getClientErrorMessage(statusCode: number): string {
        switch (statusCode) {
            case 400: return 'Invalid request format';
            case 403: return 'Access forbidden';
            case 404: return 'Resource not found';
            case 405: return 'Method not allowed';
            case 408: return 'Request timeout';
            case 413: return 'Request too large';
            case 422: return 'Invalid request parameters';
            case 429: return 'Rate limit exceeded';
            default: return 'Client error';
        }
    }

    private static sanitizeErrorMessage(message: string): string {
        // Remove sensitive information from error messages
        return message
            .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
            .replace(/token["\s]*[:=]["\s]*[A-Za-z0-9\-._~+/]+=*/gi, 'token: [REDACTED]')
            .replace(/key["\s]*[:=]["\s]*[A-Za-z0-9\-._~+/]+=*/gi, 'key: [REDACTED]')
            .replace(/password["\s]*[:=]["\s]*[^\s"]+/gi, 'password: [REDACTED]')
            .replace(/secret["\s]*[:=]["\s]*[^\s"]+/gi, 'secret: [REDACTED]')
            .replace(/authorization["\s]*[:=]["\s]*[^\s"]+/gi, 'authorization: [REDACTED]');
    }

    private static recordError(type: ErrorType, statusCode: number, message: string, requestId: string): void {
        const errorMetric: ErrorMetrics = {
            errorType: type,
            statusCode,
            message,
            timestamp: Date.now(),
            requestId,
            retryAttempt: 0
        };

        this.errorMetrics.push(errorMetric);

        // Keep only recent errors to prevent memory bloat
        if (this.errorMetrics.length > this.MAX_ERROR_HISTORY) {
            this.errorMetrics = this.errorMetrics.slice(-this.MAX_ERROR_HISTORY);
        }

        // Log error for debugging (without sensitive info)
        console.error(`[${requestId}] ${type}: ${statusCode} - ${message}`);
    }

    public static createErrorResponse(classification: ErrorClassification, requestId?: string): Response {
        const errorBody = {
            error: {
                code: classification.statusCode,
                message: classification.message,
                type: classification.type,
                ...(requestId && { requestId })
            }
        };

        return new Response(JSON.stringify(errorBody), {
            status: classification.statusCode,
            headers: {
                'Content-Type': 'application/json',
                ...(requestId && { 'X-Request-ID': requestId })
            }
        });
    }

    public static createStreamingErrorResponse(classification: ErrorClassification, requestId?: string): Response {
        const errorEvent = `data: ${JSON.stringify({
            error: {
                code: classification.statusCode,
                message: classification.message,
                type: classification.type
            }
        })}\n\n`;

        return new Response(errorEvent, {
            status: classification.statusCode,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                ...(requestId && { 'X-Request-ID': requestId })
            }
        });
    }

    public static getErrorMetrics(): {
        totalErrors: number;
        errorsByType: Record<ErrorType, number>;
        recentErrors: ErrorMetrics[];
        errorRate: number;
    } {
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        const recentErrors = this.errorMetrics.filter(e => e.timestamp > oneHourAgo);

        const errorsByType = recentErrors.reduce((acc, error) => {
            acc[error.errorType] = (acc[error.errorType] || 0) + 1;
            return acc;
        }, {} as Record<ErrorType, number>);

        return {
            totalErrors: this.errorMetrics.length,
            errorsByType,
            recentErrors: recentErrors.slice(-50), // Last 50 errors
            errorRate: recentErrors.length / 60 // Errors per minute in last hour
        };
    }

    public static clearErrorHistory(): void {
        this.errorMetrics = [];
    }
}

export class ErrorLogger {
    public static logError(
        error: any, 
        context: string, 
        requestId?: string, 
        additionalInfo?: Record<string, any>
    ): void {
        const timestamp = new Date().toISOString();
        const sanitizedError = this.sanitizeForLogging(error);
        const sanitizedInfo = additionalInfo ? this.sanitizeForLogging(additionalInfo) : {};

        console.error(`[${timestamp}] [${requestId || 'unknown'}] ${context}:`, {
            error: sanitizedError,
            ...sanitizedInfo
        });
    }

    public static logWarning(
        message: string, 
        context: string, 
        requestId?: string, 
        additionalInfo?: Record<string, any>
    ): void {
        const timestamp = new Date().toISOString();
        const sanitizedInfo = additionalInfo ? this.sanitizeForLogging(additionalInfo) : {};

        console.warn(`[${timestamp}] [${requestId || 'unknown'}] ${context}: ${message}`, sanitizedInfo);
    }

    public static logInfo(
        message: string, 
        context: string, 
        requestId?: string, 
        additionalInfo?: Record<string, any>
    ): void {
        const timestamp = new Date().toISOString();
        const sanitizedInfo = additionalInfo ? this.sanitizeForLogging(additionalInfo) : {};

        console.log(`[${timestamp}] [${requestId || 'unknown'}] ${context}: ${message}`, sanitizedInfo);
    }

    private static sanitizeForLogging(obj: any): any {
        if (typeof obj === 'string') {
            return this.sanitizeString(obj);
        }

        if (obj && typeof obj === 'object') {
            const sanitized: any = {};
            for (const [key, value] of Object.entries(obj)) {
                if (this.isSensitiveKey(key)) {
                    sanitized[key] = '[REDACTED]';
                } else if (typeof value === 'string') {
                    sanitized[key] = this.sanitizeString(value);
                } else if (value && typeof value === 'object') {
                    sanitized[key] = this.sanitizeForLogging(value);
                } else {
                    sanitized[key] = value;
                }
            }
            return sanitized;
        }

        return obj;
    }

    private static sanitizeString(str: string): string {
        return str
            .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
            .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "[REDACTED]"')
            .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token": "[REDACTED]"')
            .replace(/"token"\s*:\s*"[^"]+"/g, '"token": "[REDACTED]"')
            .replace(/"key"\s*:\s*"[^"]+"/g, '"key": "[REDACTED]"')
            .replace(/"password"\s*:\s*"[^"]+"/g, '"password": "[REDACTED]"')
            .replace(/"secret"\s*:\s*"[^"]+"/g, '"secret": "[REDACTED]"');
    }

    private static isSensitiveKey(key: string): boolean {
        const sensitiveKeys = [
            'token', 'access_token', 'refresh_token', 'id_token',
            'password', 'secret', 'key', 'authorization', 'auth',
            'credential', 'credentials', 'bearer'
        ];
        return sensitiveKeys.some(sensitive => 
            key.toLowerCase().includes(sensitive.toLowerCase())
        );
    }
}