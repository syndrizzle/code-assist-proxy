import { Env } from './types';
import { 
	validateConfiguration, 
	createFeatureFlags, 
	FeatureFlagManager,
	logConfigurationStatus,
	formatConfigurationErrors
} from './config';

/**
 * Global feature flag manager instance
 */
let globalFeatureFlagManager: FeatureFlagManager | null = null;

/**
 * Initialize the feature flag system with environment configuration
 */
export function initializeFeatureFlags(env: Env): {
	manager: FeatureFlagManager;
	errors: string[];
} {
	console.log('🚀 Initializing feature flag system...');
	
	// Validate configuration
	const { config, errors } = validateConfiguration(env);
	
	// Log configuration status
	logConfigurationStatus(config, errors);
	
	// Create feature flags
	const flags = createFeatureFlags(config, env);
	
	// Create manager
	const manager = new FeatureFlagManager(flags);
	
	// Set global reference
	globalFeatureFlagManager = manager;
	
	// Log feature flag status
	manager.logStatus();
	
	// Setup environment-based runtime overrides if needed
	setupEnvironmentOverrides(manager, env);
	
	const errorMessages = errors.length > 0 ? [formatConfigurationErrors(errors)] : [];
	
	console.log('✅ Feature flag system initialized successfully');
	
	return { manager, errors: errorMessages };
}

/**
 * Get the global feature flag manager instance
 */
export function getFeatureFlagManager(): FeatureFlagManager {
	if (!globalFeatureFlagManager) {
		throw new Error('Feature flag manager not initialized. Call initializeFeatureFlags() first.');
	}
	return globalFeatureFlagManager;
}

/**
 * Setup environment-based runtime overrides
 */
function setupEnvironmentOverrides(manager: FeatureFlagManager, env: Env): void {
	// Example: Disable certain features in development
	if (env.ENVIRONMENT === 'development') {
		manager.setFlag('monitoring', 'detailedLogging', true);
		manager.setFlag('streaming', 'compressionEnabled', false);
	}
	
	// Example: Enable aggressive caching in production
	if (env.ENVIRONMENT === 'production') {
		manager.setFlag('caching', 'ttlMultiplier', 2.0);
		manager.setFlag('retry', 'jitterEnabled', true);
	}
	
	// Example: Performance mode override
	if (env.PERFORMANCE_MODE === 'high') {
		manager.setFlag('connectionPooling', 'maxConnections', 20);
		manager.setFlag('streaming', 'bufferSize', 16384);
		manager.setFlag('caching', 'strategy', 'memory');
	}
}

/**
 * Utility functions for common feature flag checks
 */
export const FeatureFlags = {
	/**
	 * Check if connection pooling is enabled
	 */
	isConnectionPoolingEnabled(): boolean {
		return getFeatureFlagManager().getFlag('connectionPooling', 'enabled');
	},

	/**
	 * Get connection pooling strategy
	 */
	getConnectionPoolingStrategy(): 'http2' | 'http1' | 'adaptive' {
		return getFeatureFlagManager().getFlag('connectionPooling', 'strategy');
	},

	/**
	 * Check if request deduplication should be used
	 */
	shouldDeduplicateRequests(): boolean {
		return getFeatureFlagManager().getFlag('caching', 'modelNameCaching');
	},

	/**
	 * Get retry configuration
	 */
	getRetryConfig(): {
		enabled: boolean;
		strategy: 'exponential' | 'linear' | 'fixed';
		maxAttempts: number;
		baseDelayMs: number;
		jitterEnabled: boolean;
	} {
		const manager = getFeatureFlagManager();
		return {
			enabled: manager.getFlag('retry', 'enabled'),
			strategy: manager.getFlag('retry', 'strategy'),
			maxAttempts: manager.getFlag('retry', 'maxAttempts'),
			baseDelayMs: manager.getFlag('retry', 'baseDelayMs'),
			jitterEnabled: manager.getFlag('retry', 'jitterEnabled')
		};
	},

	/**
	 * Get streaming configuration
	 */
	getStreamingConfig(): {
		optimizedParsing: boolean;
		zeroCopyEnabled: boolean;
		bufferSize: number;
		compressionEnabled: boolean;
	} {
		const manager = getFeatureFlagManager();
		return {
			optimizedParsing: manager.getFlag('streaming', 'optimizedParsing'),
			zeroCopyEnabled: manager.getFlag('streaming', 'zeroCopyEnabled'),
			bufferSize: manager.getFlag('streaming', 'bufferSize'),
			compressionEnabled: manager.getFlag('streaming', 'compressionEnabled')
		};
	},

	/**
	 * Check if detailed monitoring is enabled
	 */
	isDetailedMonitoringEnabled(): boolean {
		const manager = getFeatureFlagManager();
		return manager.getFlag('monitoring', 'metricsEnabled') && 
			   manager.getFlag('monitoring', 'performanceTracking');
	},

	/**
	 * Subscribe to feature flag changes with cleanup
	 */
	subscribeToChanges<T>(
		category: keyof import('./config').FeatureFlags,
		property: string,
		callback: (value: T) => void
	): () => void {
		const manager = getFeatureFlagManager();
		return manager.subscribe(category as any, property as any, callback);
	}
};

/**
 * Example usage in request handler
 */
export function exampleUsage(): void {
	// Check if connection pooling is enabled
	if (FeatureFlags.isConnectionPoolingEnabled()) {
		const strategy = FeatureFlags.getConnectionPoolingStrategy();
		console.log(`Using connection pooling with strategy: ${strategy}`);
	}

	// Get retry configuration
	const retryConfig = FeatureFlags.getRetryConfig();
	if (retryConfig.enabled) {
		console.log(`Retry enabled: ${retryConfig.strategy} strategy, max ${retryConfig.maxAttempts} attempts`);
	}

	// Subscribe to streaming configuration changes
	const unsubscribe = FeatureFlags.subscribeToChanges(
		'streaming',
		'bufferSize',
		(newSize: number) => {
			console.log(`Streaming buffer size changed to: ${newSize}`);
		}
	);

	// Later, unsubscribe when no longer needed
	// unsubscribe();
}