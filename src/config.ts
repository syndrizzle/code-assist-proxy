import { Env } from './types';

// --- Google Code Assist API Constants ---
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";

// --- OAuth2 Configuration ---
export const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "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";
export const OAUTH_REFRESH_URL = "https://oauth2.googleapis.com/token";

// --- Token Management ---
export const TOKEN_BUFFER_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds
export const KV_TOKEN_KEY = "oauth_token_cache";

// --- Project ID Caching ---
export const PROJECT_ID_CACHE_KEY = "project_id_cache";
export const PROJECT_ID_CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds
export const PROJECT_ID_VALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// --- Connection Pooling Configuration ---
export const CONNECTION_POOL_SIZE = 10;
export const CONNECTION_TIMEOUT = 30000; // 30 seconds
export const KEEP_ALIVE_TIMEOUT = 60000; // 60 seconds
export const MAX_IDLE_TIME = 120000; // 2 minutes

// --- Circuit Breaker Configuration ---
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const CIRCUIT_BREAKER_TIMEOUT_MS = 60000; // 1 minute
export const CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS = 3;
export const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 30000; // 30 seconds

// --- Retry Configuration ---
export const MAX_RETRY_ATTEMPTS = 3;
export const BASE_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 10000;
export const RETRY_JITTER_FACTOR = 0.1;

// --- Configuration Defaults ---
export const DEFAULT_CONFIG = {
	ENABLE_CONNECTION_POOLING: 'true',
	TOKEN_REFRESH_BUFFER_MINUTES: '5',
	MAX_CONCURRENT_REQUESTS: '100',
	ENABLE_REQUEST_DEDUPLICATION: 'false',
	CACHE_PROJECT_ID_TTL_HOURS: '1',
	ENABLE_CIRCUIT_BREAKER: 'true',
	CIRCUIT_BREAKER_THRESHOLD: '5',
	CIRCUIT_BREAKER_TIMEOUT_MS: '60000'
} as const;

// --- Configuration Validation ---
export interface ConfigValidationError {
	field: string;
	value: string | undefined;
	message: string;
	suggestion?: string;
}

export interface ValidatedConfig {
	enableConnectionPooling: boolean;
	tokenRefreshBufferMinutes: number;
	maxConcurrentRequests: number;
	enableRequestDeduplication: boolean;
	cacheProjectIdTtlHours: number;
	enableCircuitBreaker: boolean;
	circuitBreakerThreshold: number;
	circuitBreakerTimeoutMs: number;
}

/**
 * Validates and parses environment configuration with helpful error messages
 */
export function validateConfiguration(env: Env): { config: ValidatedConfig; errors: ConfigValidationError[] } {
	const errors: ConfigValidationError[] = [];
	const config: ValidatedConfig = {} as ValidatedConfig;

	// Validate required fields
	if (!env.GCP_SERVICE_ACCOUNT) {
		errors.push({
			field: 'GCP_SERVICE_ACCOUNT',
			value: env.GCP_SERVICE_ACCOUNT,
			message: 'GCP_SERVICE_ACCOUNT is required for authentication',
			suggestion: 'Set GCP_SERVICE_ACCOUNT environment variable with your service account JSON'
		});
	} else {
		try {
			JSON.parse(env.GCP_SERVICE_ACCOUNT);
		} catch (e) {
			errors.push({
				field: 'GCP_SERVICE_ACCOUNT',
				value: '[REDACTED]',
				message: 'GCP_SERVICE_ACCOUNT must be valid JSON',
				suggestion: 'Ensure the service account JSON is properly formatted'
			});
		}
	}

	if (!env.GEMINI_CREDS_KV) {
		errors.push({
			field: 'GEMINI_CREDS_KV',
			value: 'undefined',
			message: 'GEMINI_CREDS_KV namespace binding is required',
			suggestion: 'Ensure KV namespace is properly bound in wrangler.toml'
		});
	}

	// Validate and set optional configuration with defaults
	config.enableConnectionPooling = parseBooleanWithDefault(
		env.ENABLE_CONNECTION_POOLING,
		DEFAULT_CONFIG.ENABLE_CONNECTION_POOLING,
		'ENABLE_CONNECTION_POOLING',
		errors
	);

	config.tokenRefreshBufferMinutes = parseNumberWithDefault(
		env.TOKEN_REFRESH_BUFFER_MINUTES,
		DEFAULT_CONFIG.TOKEN_REFRESH_BUFFER_MINUTES,
		'TOKEN_REFRESH_BUFFER_MINUTES',
		{ min: 1, max: 30 },
		errors
	);

	config.maxConcurrentRequests = parseNumberWithDefault(
		env.MAX_CONCURRENT_REQUESTS,
		DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
		'MAX_CONCURRENT_REQUESTS',
		{ min: 1, max: 1000 },
		errors
	);

	config.enableRequestDeduplication = parseBooleanWithDefault(
		env.ENABLE_REQUEST_DEDUPLICATION,
		DEFAULT_CONFIG.ENABLE_REQUEST_DEDUPLICATION,
		'ENABLE_REQUEST_DEDUPLICATION',
		errors
	);

	config.cacheProjectIdTtlHours = parseNumberWithDefault(
		env.CACHE_PROJECT_ID_TTL_HOURS,
		DEFAULT_CONFIG.CACHE_PROJECT_ID_TTL_HOURS,
		'CACHE_PROJECT_ID_TTL_HOURS',
		{ min: 0.1, max: 168 }, // 6 minutes to 1 week
		errors
	);

	config.enableCircuitBreaker = parseBooleanWithDefault(
		env.ENABLE_CIRCUIT_BREAKER,
		DEFAULT_CONFIG.ENABLE_CIRCUIT_BREAKER,
		'ENABLE_CIRCUIT_BREAKER',
		errors
	);

	config.circuitBreakerThreshold = parseNumberWithDefault(
		env.CIRCUIT_BREAKER_THRESHOLD,
		DEFAULT_CONFIG.CIRCUIT_BREAKER_THRESHOLD,
		'CIRCUIT_BREAKER_THRESHOLD',
		{ min: 1, max: 100 },
		errors
	);

	config.circuitBreakerTimeoutMs = parseNumberWithDefault(
		env.CIRCUIT_BREAKER_TIMEOUT_MS,
		DEFAULT_CONFIG.CIRCUIT_BREAKER_TIMEOUT_MS,
		'CIRCUIT_BREAKER_TIMEOUT_MS',
		{ min: 1000, max: 300000 }, // 1 second to 5 minutes
		errors
	);

	return { config, errors };
}

/**
 * Helper function to parse boolean values with defaults and validation
 */
function parseBooleanWithDefault(
	value: string | undefined,
	defaultValue: string,
	fieldName: string,
	errors: ConfigValidationError[]
): boolean {
	const val = value || defaultValue;
	const lowerVal = val.toLowerCase();
	
	if (lowerVal === 'true' || lowerVal === '1' || lowerVal === 'yes') {
		return true;
	} else if (lowerVal === 'false' || lowerVal === '0' || lowerVal === 'no') {
		return false;
	} else {
		errors.push({
			field: fieldName,
			value: val,
			message: `${fieldName} must be a boolean value (true/false, 1/0, yes/no)`,
			suggestion: `Set ${fieldName} to 'true' or 'false'. Using default: ${defaultValue}`
		});
		return defaultValue.toLowerCase() === 'true';
	}
}

/**
 * Helper function to parse numeric values with defaults and validation
 */
function parseNumberWithDefault(
	value: string | undefined,
	defaultValue: string,
	fieldName: string,
	range: { min: number; max: number },
	errors: ConfigValidationError[]
): number {
	const val = value || defaultValue;
	const numVal = parseFloat(val);
	
	if (isNaN(numVal)) {
		errors.push({
			field: fieldName,
			value: val,
			message: `${fieldName} must be a valid number`,
			suggestion: `Set ${fieldName} to a number between ${range.min} and ${range.max}. Using default: ${defaultValue}`
		});
		return parseFloat(defaultValue);
	}
	
	if (numVal < range.min || numVal > range.max) {
		errors.push({
			field: fieldName,
			value: val,
			message: `${fieldName} must be between ${range.min} and ${range.max}`,
			suggestion: `Set ${fieldName} to a value within the valid range. Using default: ${defaultValue}`
		});
		return parseFloat(defaultValue);
	}
	
	return numVal;
}

/**
 * Creates a formatted error message for configuration validation errors
 */
export function formatConfigurationErrors(errors: ConfigValidationError[]): string {
	if (errors.length === 0) return '';
	
	const errorMessages = errors.map(error => {
		let message = `❌ ${error.field}: ${error.message}`;
		if (error.suggestion) {
			message += `\n   💡 Suggestion: ${error.suggestion}`;
		}
		return message;
	});
	
	return `Configuration validation failed:\n${errorMessages.join('\n')}`;
}

/**
 * Logs configuration status with helpful information
 */
export function logConfigurationStatus(config: ValidatedConfig, errors: ConfigValidationError[]): void {
	console.log('🔧 Configuration Status:');
	
	if (errors.length > 0) {
		console.warn(formatConfigurationErrors(errors));
	}
	
	console.log('📋 Active Configuration:');
	console.log(`   Connection Pooling: ${config.enableConnectionPooling ? '✅' : '❌'}`);
	console.log(`   Token Refresh Buffer: ${config.tokenRefreshBufferMinutes} minutes`);
	console.log(`   Max Concurrent Requests: ${config.maxConcurrentRequests}`);
	console.log(`   Request Deduplication: ${config.enableRequestDeduplication ? '✅' : '❌'}`);
	console.log(`   Project ID Cache TTL: ${config.cacheProjectIdTtlHours} hours`);
	console.log(`   Circuit Breaker: ${config.enableCircuitBreaker ? '✅' : '❌'}`);
	
	if (config.enableCircuitBreaker) {
		console.log(`   Circuit Breaker Threshold: ${config.circuitBreakerThreshold} failures`);
		console.log(`   Circuit Breaker Timeout: ${config.circuitBreakerTimeoutMs}ms`);
	}
}

// --- Feature Flag Management ---
export interface FeatureFlags {
	connectionPooling: {
		enabled: boolean;
		strategy: 'http2' | 'http1' | 'adaptive';
		maxConnections: number;
		keepAliveTimeout: number;
	};
	caching: {
		tokenCaching: boolean;
		projectIdCaching: boolean;
		modelNameCaching: boolean;
		strategy: 'memory' | 'kv' | 'hybrid';
		ttlMultiplier: number;
	};
	retry: {
		enabled: boolean;
		strategy: 'exponential' | 'linear' | 'fixed';
		maxAttempts: number;
		baseDelayMs: number;
		jitterEnabled: boolean;
	};
	streaming: {
		optimizedParsing: boolean;
		zeroCopyEnabled: boolean;
		bufferSize: number;
		compressionEnabled: boolean;
	};
	monitoring: {
		metricsEnabled: boolean;
		detailedLogging: boolean;
		performanceTracking: boolean;
		errorTracking: boolean;
	};
}

/**
 * Creates feature flags based on environment configuration
 */
export function createFeatureFlags(config: ValidatedConfig, env: Env): FeatureFlags {
	return {
		connectionPooling: {
			enabled: config.enableConnectionPooling,
			strategy: parseEnumWithDefault(
				env.CONNECTION_POOLING_STRATEGY,
				'adaptive',
				['http2', 'http1', 'adaptive']
			) as 'http2' | 'http1' | 'adaptive',
			maxConnections: parseNumberWithDefault(
				env.MAX_CONNECTIONS,
				'10',
				'MAX_CONNECTIONS',
				{ min: 1, max: 100 },
				[]
			),
			keepAliveTimeout: parseNumberWithDefault(
				env.KEEP_ALIVE_TIMEOUT_MS,
				'60000',
				'KEEP_ALIVE_TIMEOUT_MS',
				{ min: 1000, max: 300000 },
				[]
			)
		},
		caching: {
			tokenCaching: true, // Always enabled for authentication
			projectIdCaching: config.cacheProjectIdTtlHours > 0,
			modelNameCaching: parseBooleanWithDefault(
				env.ENABLE_MODEL_NAME_CACHING,
				'true',
				'ENABLE_MODEL_NAME_CACHING',
				[]
			),
			strategy: parseEnumWithDefault(
				env.CACHING_STRATEGY,
				'hybrid',
				['memory', 'kv', 'hybrid']
			) as 'memory' | 'kv' | 'hybrid',
			ttlMultiplier: parseNumberWithDefault(
				env.CACHE_TTL_MULTIPLIER,
				'1.0',
				'CACHE_TTL_MULTIPLIER',
				{ min: 0.1, max: 10.0 },
				[]
			)
		},
		retry: {
			enabled: parseBooleanWithDefault(
				env.ENABLE_RETRY_LOGIC,
				'true',
				'ENABLE_RETRY_LOGIC',
				[]
			),
			strategy: parseEnumWithDefault(
				env.RETRY_STRATEGY,
				'exponential',
				['exponential', 'linear', 'fixed']
			) as 'exponential' | 'linear' | 'fixed',
			maxAttempts: parseNumberWithDefault(
				env.MAX_RETRY_ATTEMPTS,
				'3',
				'MAX_RETRY_ATTEMPTS',
				{ min: 0, max: 10 },
				[]
			),
			baseDelayMs: parseNumberWithDefault(
				env.RETRY_BASE_DELAY_MS,
				'1000',
				'RETRY_BASE_DELAY_MS',
				{ min: 100, max: 10000 },
				[]
			),
			jitterEnabled: parseBooleanWithDefault(
				env.ENABLE_RETRY_JITTER,
				'true',
				'ENABLE_RETRY_JITTER',
				[]
			)
		},
		streaming: {
			optimizedParsing: parseBooleanWithDefault(
				env.ENABLE_OPTIMIZED_PARSING,
				'true',
				'ENABLE_OPTIMIZED_PARSING',
				[]
			),
			zeroCopyEnabled: parseBooleanWithDefault(
				env.ENABLE_ZERO_COPY_STREAMING,
				'true',
				'ENABLE_ZERO_COPY_STREAMING',
				[]
			),
			bufferSize: parseNumberWithDefault(
				env.STREAMING_BUFFER_SIZE,
				'8192',
				'STREAMING_BUFFER_SIZE',
				{ min: 1024, max: 65536 },
				[]
			),
			compressionEnabled: parseBooleanWithDefault(
				env.ENABLE_COMPRESSION,
				'false',
				'ENABLE_COMPRESSION',
				[]
			)
		},
		monitoring: {
			metricsEnabled: parseBooleanWithDefault(
				env.ENABLE_METRICS,
				'true',
				'ENABLE_METRICS',
				[]
			),
			detailedLogging: parseBooleanWithDefault(
				env.ENABLE_DETAILED_LOGGING,
				'false',
				'ENABLE_DETAILED_LOGGING',
				[]
			),
			performanceTracking: parseBooleanWithDefault(
				env.ENABLE_PERFORMANCE_TRACKING,
				'true',
				'ENABLE_PERFORMANCE_TRACKING',
				[]
			),
			errorTracking: parseBooleanWithDefault(
				env.ENABLE_ERROR_TRACKING,
				'true',
				'ENABLE_ERROR_TRACKING',
				[]
			)
		}
	};
}

/**
 * Helper function to parse enum values with defaults
 */
function parseEnumWithDefault<T extends string>(
	value: string | undefined,
	defaultValue: T,
	validValues: readonly T[]
): T {
	if (!value) return defaultValue;
	
	const lowerValue = value.toLowerCase() as T;
	if (validValues.includes(lowerValue)) {
		return lowerValue;
	}
	
	return defaultValue;
}

/**
 * Runtime feature flag manager for dynamic configuration updates
 */
export class FeatureFlagManager {
	private flags: FeatureFlags;
	private overrides: Map<string, any> = new Map();
	private listeners: Map<string, ((value: any) => void)[]> = new Map();

	constructor(initialFlags: FeatureFlags) {
		this.flags = { ...initialFlags };
	}

	/**
	 * Get current value of a feature flag
	 */
	getFlag<K extends keyof FeatureFlags>(category: K): FeatureFlags[K];
	getFlag<K extends keyof FeatureFlags, P extends keyof FeatureFlags[K]>(
		category: K,
		property: P
	): FeatureFlags[K][P];
	getFlag<K extends keyof FeatureFlags, P extends keyof FeatureFlags[K]>(
		category: K,
		property?: P
	): FeatureFlags[K] | FeatureFlags[K][P] {
		const flagKey = property ? `${String(category)}.${String(property)}` : String(category);
		
		if (this.overrides.has(flagKey)) {
			return this.overrides.get(flagKey);
		}
		
		if (property) {
			return this.flags[category][property];
		}
		
		return this.flags[category];
	}

	/**
	 * Set a runtime override for a feature flag
	 */
	setFlag<K extends keyof FeatureFlags, P extends keyof FeatureFlags[K]>(
		category: K,
		property: P,
		value: FeatureFlags[K][P]
	): void {
		const flagKey = `${String(category)}.${String(property)}`;
		const oldValue = this.getFlag(category, property);
		
		this.overrides.set(flagKey, value);
		
		// Notify listeners
		const categoryListeners = this.listeners.get(String(category)) || [];
		const propertyListeners = this.listeners.get(flagKey) || [];
		
		[...categoryListeners, ...propertyListeners].forEach(listener => {
			try {
				listener(value);
			} catch (error) {
				console.error(`Error in feature flag listener for ${flagKey}:`, error);
			}
		});
		
		console.log(`🚩 Feature flag updated: ${flagKey} = ${JSON.stringify(value)} (was: ${JSON.stringify(oldValue)})`);
	}

	/**
	 * Subscribe to feature flag changes
	 */
	subscribe<K extends keyof FeatureFlags>(
		category: K,
		listener: (flags: FeatureFlags[K]) => void
	): () => void;
	subscribe<K extends keyof FeatureFlags, P extends keyof FeatureFlags[K]>(
		category: K,
		property: P,
		listener: (value: FeatureFlags[K][P]) => void
	): () => void;
	subscribe<K extends keyof FeatureFlags, P extends keyof FeatureFlags[K]>(
		category: K,
		propertyOrListener: P | ((flags: FeatureFlags[K]) => void),
		listener?: (value: FeatureFlags[K][P]) => void
	): () => void {
		let flagKey: string;
		let actualListener: (value: any) => void;
		
		if (typeof propertyOrListener === 'function') {
			flagKey = String(category);
			actualListener = propertyOrListener;
		} else {
			flagKey = `${String(category)}.${String(propertyOrListener)}`;
			actualListener = listener!;
		}
		
		if (!this.listeners.has(flagKey)) {
			this.listeners.set(flagKey, []);
		}
		
		this.listeners.get(flagKey)!.push(actualListener);
		
		// Return unsubscribe function
		return () => {
			const listeners = this.listeners.get(flagKey);
			if (listeners) {
				const index = listeners.indexOf(actualListener);
				if (index > -1) {
					listeners.splice(index, 1);
				}
			}
		};
	}

	/**
	 * Clear all runtime overrides
	 */
	clearOverrides(): void {
		this.overrides.clear();
		console.log('🚩 All feature flag overrides cleared');
	}

	/**
	 * Get current configuration summary
	 */
	getConfigSummary(): Record<string, any> {
		const summary: Record<string, any> = {};
		
		for (const [category, flags] of Object.entries(this.flags)) {
			summary[category] = {};
			for (const [property, value] of Object.entries(flags)) {
				const flagKey = `${category}.${property}`;
				summary[category][property] = this.overrides.has(flagKey) 
					? { value: this.overrides.get(flagKey), overridden: true }
					: { value, overridden: false };
			}
		}
		
		return summary;
	}

	/**
	 * Log current feature flag status
	 */
	logStatus(): void {
		console.log('🚩 Feature Flags Status:');
		
		const summary = this.getConfigSummary();
		for (const [category, flags] of Object.entries(summary)) {
			console.log(`   ${category}:`);
			for (const [property, info] of Object.entries(flags as Record<string, any>)) {
				const status = info.overridden ? '🔄' : '✅';
				console.log(`     ${property}: ${JSON.stringify(info.value)} ${status}`);
			}
		}
		
		if (this.overrides.size > 0) {
			console.log(`   Active overrides: ${this.overrides.size}`);
		}
	}
}
