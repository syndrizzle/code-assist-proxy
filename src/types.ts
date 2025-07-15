// --- Environment Variable Typings ---
export interface Env {
	GCP_SERVICE_ACCOUNT: string; // Contains OAuth2 credentials JSON
	GEMINI_PROJECT_ID?: string;
	GEMINI_CREDS_KV: KVNamespace; // Cloudflare KV for token caching
	
	// Basic optimization flags and configuration options
	ENABLE_CONNECTION_POOLING?: string;
	TOKEN_REFRESH_BUFFER_MINUTES?: string;
	MAX_CONCURRENT_REQUESTS?: string;
	ENABLE_REQUEST_DEDUPLICATION?: string;
	CACHE_PROJECT_ID_TTL_HOURS?: string;
	ENABLE_CIRCUIT_BREAKER?: string;
	CIRCUIT_BREAKER_THRESHOLD?: string;
	CIRCUIT_BREAKER_TIMEOUT_MS?: string;
	
	// Advanced feature flag environment variables
	CONNECTION_POOLING_STRATEGY?: string; // 'http2' | 'http1' | 'adaptive'
	MAX_CONNECTIONS?: string;
	KEEP_ALIVE_TIMEOUT_MS?: string;
	
	ENABLE_MODEL_NAME_CACHING?: string;
	CACHING_STRATEGY?: string; // 'memory' | 'kv' | 'hybrid'
	CACHE_TTL_MULTIPLIER?: string;
	
	ENABLE_RETRY_LOGIC?: string;
	RETRY_STRATEGY?: string; // 'exponential' | 'linear' | 'fixed'
	MAX_RETRY_ATTEMPTS?: string;
	RETRY_BASE_DELAY_MS?: string;
	ENABLE_RETRY_JITTER?: string;
	
	ENABLE_OPTIMIZED_PARSING?: string;
	ENABLE_ZERO_COPY_STREAMING?: string;
	STREAMING_BUFFER_SIZE?: string;
	ENABLE_COMPRESSION?: string;
	
	ENABLE_METRICS?: string;
	ENABLE_DETAILED_LOGGING?: string;
	ENABLE_PERFORMANCE_TRACKING?: string;
	ENABLE_ERROR_TRACKING?: string;
	
	// Environment and performance mode flags
	ENVIRONMENT?: string; // 'development' | 'production' | 'staging'
	PERFORMANCE_MODE?: string; // 'high' | 'normal' | 'low'
}

// --- OAuth2 Credentials Interface ---
export interface OAuth2Credentials {
	access_token: string;
	refresh_token: string;
	scope: string;
	token_type: string;
	id_token: string;
	expiry_date: number;
}
// --- Performance Metrics Interfaces ---
export interface PerformanceMetrics {
	requestStartTime: number;
	authTime: number;
	transformTime: number;
	upstreamTime: number;
	totalTime: number;
	memoryUsage?: number;
	cacheHitRate?: number;
}

export interface RequestTimings {
	start: number;
	authStart?: number;
	authEnd?: number;
	transformStart?: number;
	transformEnd?: number;
	upstreamStart?: number;
	upstreamEnd?: number;
	end?: number;
}

export interface SystemMetrics {
	activeRequests: number;
	totalRequests: number;
	errorRate: number;
	averageResponseTime: number;
	tokenRefreshCount: number;
	cacheHitCount: number;
	cacheMissCount: number;
}

// --- Enhanced Token Cache Interface ---
export interface CachedTokenData {
	access_token: string;
	expiry_date: number;
	refresh_count: number;
	last_used: number;
	created_at: number;
	token_type: string;
	scope: string;
}

export interface TokenCacheMetadata {
	key: string;
	ttl: number;
	size: number;
	lastAccessed: number;
	hitCount: number;
}

// --- Request Context Interface ---
export interface RequestContext {
	requestId: string;
	startTime: number;
	model: string;
	action: string;
	isStreaming: boolean;
	clientIP?: string;
	userAgent?: string;
	metrics: PerformanceMetrics;
	timings: RequestTimings;
	retryCount: number;
	cacheUsed: boolean;
}

// --- Project ID Cache Interface ---
export interface ProjectCache {
	project_id: string;
	discovered_at: number;
	ttl: number;
	source: 'environment' | 'discovery' | 'cache';
	validation_count: number;
}

// --- Circuit Breaker Interface ---
export interface CircuitBreakerState {
	state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
	failureCount: number;
	lastFailureTime: number;
	nextAttemptTime: number;
	successCount: number;
}

// --- Error Tracking Interface ---
export interface ErrorMetrics {
	errorType: 'CLIENT_ERROR' | 'AUTH_ERROR' | 'UPSTREAM_ERROR' | 'SYSTEM_ERROR';
	statusCode: number;
	message: string;
	timestamp: number;
	requestId: string;
	retryAttempt: number;
}