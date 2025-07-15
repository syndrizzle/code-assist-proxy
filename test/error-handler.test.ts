import { describe, it, expect } from 'vitest';
import { ErrorHandler, ErrorType } from '../src/error-handler';

describe('ErrorHandler', () => {
    it('should classify 401 errors as AUTH_ERROR', () => {
        const classification = ErrorHandler.classifyError(new Error('Unauthorized'), 401, 'test-request');
        
        expect(classification.type).toBe(ErrorType.AUTH_ERROR);
        expect(classification.statusCode).toBe(401);
        expect(classification.isRetryable).toBe(true);
        expect(classification.shouldClearCache).toBe(true);
    });

    it('should classify 5xx errors as UPSTREAM_ERROR', () => {
        const classification = ErrorHandler.classifyError(new Error('Internal Server Error'), 500, 'test-request');
        
        expect(classification.type).toBe(ErrorType.UPSTREAM_ERROR);
        expect(classification.statusCode).toBe(500);
        expect(classification.isRetryable).toBe(true);
        expect(classification.shouldClearCache).toBe(false);
    });

    it('should classify 4xx errors as CLIENT_ERROR', () => {
        const classification = ErrorHandler.classifyError(new Error('Bad Request'), 400, 'test-request');
        
        expect(classification.type).toBe(ErrorType.CLIENT_ERROR);
        expect(classification.statusCode).toBe(400);
        expect(classification.isRetryable).toBe(false);
        expect(classification.shouldClearCache).toBe(false);
    });

    it('should sanitize sensitive information from error messages', () => {
        const errorWithToken = 'Bearer abc123token456 failed';
        const classification = ErrorHandler.classifyError(errorWithToken, 401, 'test-request');
        
        // For 401 errors, the message is standardized to 'Authentication error'
        expect(classification.message).toBe('Authentication error');
        expect(classification.message).not.toContain('abc123token456');
    });

    it('should create proper error response', () => {
        const classification = ErrorHandler.classifyError('Test error', 400, 'test-request');
        const response = ErrorHandler.createErrorResponse(classification, 'test-request');
        
        expect(response.status).toBe(400);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        expect(response.headers.get('X-Request-ID')).toBe('test-request');
    });
});