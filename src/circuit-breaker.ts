import { CircuitBreakerState } from "./types";

export interface CircuitBreakerConfig {
    failureThreshold: number;
    timeoutMs: number;
    halfOpenMaxCalls: number;
    resetTimeoutMs: number;
}

export class CircuitBreaker {
    private state: CircuitBreakerState;
    private config: CircuitBreakerConfig;
    private static instances = new Map<string, CircuitBreaker>();

    constructor(name: string, config: CircuitBreakerConfig) {
        this.config = config;
        this.state = {
            state: 'CLOSED',
            failureCount: 0,
            lastFailureTime: 0,
            nextAttemptTime: 0,
            successCount: 0
        };
    }

    public static getInstance(name: string, config: CircuitBreakerConfig): CircuitBreaker {
        if (!CircuitBreaker.instances.has(name)) {
            CircuitBreaker.instances.set(name, new CircuitBreaker(name, config));
        }
        return CircuitBreaker.instances.get(name)!;
    }

    public async execute<T>(operation: () => Promise<T>): Promise<T> {
        if (this.state.state === 'OPEN') {
            if (Date.now() < this.state.nextAttemptTime) {
                throw new Error('Circuit breaker is OPEN - fast failing request');
            }
            // Transition to HALF_OPEN
            this.state.state = 'HALF_OPEN';
            this.state.successCount = 0;
        }

        try {
            const result = await operation();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    private onSuccess(): void {
        if (this.state.state === 'HALF_OPEN') {
            this.state.successCount++;
            if (this.state.successCount >= this.config.halfOpenMaxCalls) {
                this.reset();
            }
        } else if (this.state.state === 'CLOSED') {
            this.state.failureCount = 0;
        }
    }

    private onFailure(): void {
        this.state.failureCount++;
        this.state.lastFailureTime = Date.now();

        if (this.state.state === 'HALF_OPEN') {
            this.open();
        } else if (this.state.failureCount >= this.config.failureThreshold) {
            this.open();
        }
    }

    private open(): void {
        this.state.state = 'OPEN';
        this.state.nextAttemptTime = Date.now() + this.config.resetTimeoutMs;
    }

    private reset(): void {
        this.state.state = 'CLOSED';
        this.state.failureCount = 0;
        this.state.successCount = 0;
        this.state.lastFailureTime = 0;
        this.state.nextAttemptTime = 0;
    }

    public getState(): CircuitBreakerState {
        return { ...this.state };
    }

    public isOpen(): boolean {
        return this.state.state === 'OPEN' && Date.now() < this.state.nextAttemptTime;
    }
}

export class RetryManager {
    public static async executeWithExponentialBackoff<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        baseDelayMs: number = 1000,
        maxDelayMs: number = 10000,
        jitterFactor: number = 0.1
    ): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;
                
                if (attempt === maxRetries) {
                    break;
                }

                // Calculate delay with exponential backoff and jitter
                const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
                const jitter = exponentialDelay * jitterFactor * Math.random();
                const delay = exponentialDelay + jitter;

                console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms delay`);
                await this.sleep(delay);
            }
        }

        throw lastError!;
    }

    public static async executeWithRateLimitRespect<T>(
        operation: () => Promise<Response>,
        maxRetries: number = 3
    ): Promise<Response> {
        let lastError: Error;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await operation();
                
                // Check for rate limiting
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    if (retryAfter && attempt < maxRetries) {
                        const delayMs = parseInt(retryAfter) * 1000;
                        console.log(`Rate limited, waiting ${delayMs}ms before retry`);
                        await this.sleep(delayMs);
                        continue;
                    }
                }
                
                return response;
            } catch (error) {
                lastError = error as Error;
                
                if (attempt === maxRetries) {
                    break;
                }

                // Use exponential backoff for network errors
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                await this.sleep(delay);
            }
        }

        throw lastError!;
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}