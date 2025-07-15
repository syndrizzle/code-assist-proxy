import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker';

describe('CircuitBreaker', () => {
    it('should start in CLOSED state', () => {
        const cb = new CircuitBreaker('test', {
            failureThreshold: 3,
            timeoutMs: 1000,
            halfOpenMaxCalls: 2,
            resetTimeoutMs: 5000
        });
        
        const state = cb.getState();
        expect(state.state).toBe('CLOSED');
        expect(state.failureCount).toBe(0);
    });

    it('should open circuit after failure threshold', async () => {
        const cb = new CircuitBreaker('test-failures', {
            failureThreshold: 2,
            timeoutMs: 1000,
            halfOpenMaxCalls: 2,
            resetTimeoutMs: 5000
        });

        // Simulate failures
        for (let i = 0; i < 2; i++) {
            try {
                await cb.execute(async () => {
                    throw new Error('Test failure');
                });
            } catch (e) {
                // Expected to fail
            }
        }

        const state = cb.getState();
        expect(state.state).toBe('OPEN');
        expect(state.failureCount).toBe(2);
    });

    it('should fast-fail when circuit is open', async () => {
        const cb = new CircuitBreaker('test-fast-fail', {
            failureThreshold: 1,
            timeoutMs: 1000,
            halfOpenMaxCalls: 2,
            resetTimeoutMs: 60000 // Long timeout to keep circuit open
        });

        // Trigger circuit to open
        try {
            await cb.execute(async () => {
                throw new Error('Test failure');
            });
        } catch (e) {
            // Expected to fail
        }

        // Next call should fast-fail
        try {
            await cb.execute(async () => {
                return 'success';
            });
            expect.fail('Should have fast-failed');
        } catch (error: any) {
            expect(error.message).toContain('Circuit breaker is OPEN');
        }
    });

    it('should execute successfully when circuit is closed', async () => {
        const cb = new CircuitBreaker('test-success', {
            failureThreshold: 3,
            timeoutMs: 1000,
            halfOpenMaxCalls: 2,
            resetTimeoutMs: 5000
        });

        const result = await cb.execute(async () => {
            return 'success';
        });

        expect(result).toBe('success');
        const state = cb.getState();
        expect(state.state).toBe('CLOSED');
        expect(state.failureCount).toBe(0);
    });
});