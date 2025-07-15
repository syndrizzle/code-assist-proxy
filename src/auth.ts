import { Env, OAuth2Credentials, CachedTokenData } from "./types";
import {
	OAUTH_CLIENT_ID,
	OAUTH_CLIENT_SECRET,
	OAUTH_REFRESH_URL,
	TOKEN_BUFFER_TIME,
	KV_TOKEN_KEY
} from "./config";
import { PerformanceMetricsCollector } from "./performance-metrics";

interface TokenRefreshResponse {
	access_token: string;
	expires_in: number;
}

interface RefreshOperation {
	promise: Promise<void>;
	timestamp: number;
}

export class AuthManager {
	private env: Env;
	private cachedTokenData: CachedTokenData | null = null;
	private initPromise: Promise<void> | null = null;
	private refreshOperation: RefreshOperation | null = null;
	private pendingRequests: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	
	// Singleton instance for preventing concurrent refreshes
	private static instances = new Map<string, AuthManager>();
	
	constructor(env: Env) {
		this.env = env;
	}

	// Singleton pattern to prevent concurrent token refreshes across requests
	public static getInstance(env: Env): AuthManager {
		const key = env.GCP_SERVICE_ACCOUNT || 'default';
		if (!AuthManager.instances.has(key)) {
			AuthManager.instances.set(key, new AuthManager(env));
		}
		return AuthManager.instances.get(key)!;
	}

	public initialize(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this._initialize();
		}
		return this.initPromise;
	}

	private async _initialize(): Promise<void> {
		if (this.cachedTokenData && this.isTokenValid(this.cachedTokenData)) {
			return;
		}

		if (!this.env.GCP_SERVICE_ACCOUNT) {
			throw new Error("`GCP_SERVICE_ACCOUNT` environment variable not set.");
		}

		// 1. Try to get a cached token from KV with enhanced metadata
		const cached = await this.loadTokenFromKV();
		if (cached && this.isTokenValid(cached)) {
			console.log("Using cached token from KV.");
			this.cachedTokenData = cached;
			// Update last_used timestamp
			await this.updateTokenUsage(cached);
			return;
		}

		// 2. If no valid cached token, use the one from the environment
		const oauth2Creds: OAuth2Credentials = JSON.parse(this.env.GCP_SERVICE_ACCOUNT);
		const timeUntilExpiry = (oauth2Creds.expiry_date * 1000) - Date.now();

		if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
			console.log("Using token from environment.");
			const tokenData = this.createTokenData(oauth2Creds.access_token, oauth2Creds.expiry_date * 1000, oauth2Creds);
			this.cachedTokenData = tokenData;
			await this.cacheTokenWithMetadata(tokenData);
			return;
		}

		// 3. If the token is expired, refresh it
		console.log("Token expired, refreshing...");
		await this.refreshToken(oauth2Creds.refresh_token);
	}

	// Token validation with pre-refresh logic
	private isTokenValid(tokenData: CachedTokenData): boolean {
		const now = Date.now();
		const bufferTime = this.getTokenRefreshBuffer();
		return tokenData.expiry_date - now > bufferTime;
	}

	// Get token refresh buffer from environment or use default
	private getTokenRefreshBuffer(): number {
		const bufferMinutes = parseInt(this.env.TOKEN_REFRESH_BUFFER_MINUTES || '5');
		return bufferMinutes * 60 * 1000;
	}

	// Enhanced token loading from KV with metadata
	private async loadTokenFromKV(): Promise<CachedTokenData | null> {
		try {
			const cached = await this.env.GEMINI_CREDS_KV.get<CachedTokenData>(KV_TOKEN_KEY, "json");
			return cached;
		} catch (error) {
			console.warn("Failed to load token from KV:", error);
			return null;
		}
	}

	// Create token data with enhanced metadata
	private createTokenData(accessToken: string, expiryDate: number, oauth2Creds?: OAuth2Credentials): CachedTokenData {
		const now = Date.now();
		return {
			access_token: accessToken,
			expiry_date: expiryDate,
			refresh_count: 0,
			last_used: now,
			created_at: now,
			token_type: oauth2Creds?.token_type || 'Bearer',
			scope: oauth2Creds?.scope || ''
		};
	}

	// Update token usage timestamp
	private async updateTokenUsage(tokenData: CachedTokenData): Promise<void> {
		tokenData.last_used = Date.now();
		await this.cacheTokenWithMetadata(tokenData);
	}

	// Singleton pattern for token refresh to prevent concurrent refreshes
	private async refreshToken(refreshToken: string): Promise<void> {
		// Check if there's already a refresh operation in progress
		if (this.refreshOperation) {
			const timeSinceRefresh = Date.now() - this.refreshOperation.timestamp;
			// If refresh is recent (within 30 seconds), wait for it
			if (timeSinceRefresh < 30000) {
				console.log("Token refresh already in progress, waiting...");
				return this.refreshOperation.promise;
			} else {
				// If refresh is stale, clear it
				this.refreshOperation = null;
			}
		}

		// Create new refresh operation
		const refreshPromise = this._performTokenRefresh(refreshToken);
		this.refreshOperation = {
			promise: refreshPromise,
			timestamp: Date.now()
		};

		try {
			await refreshPromise;
		} finally {
			// Clear refresh operation when done
			this.refreshOperation = null;
			// Process any pending requests
			this.processPendingRequests();
		}
	}

	// Actual token refresh implementation
	private async _performTokenRefresh(refreshToken: string): Promise<void> {
		console.log("Performing token refresh...");
		
		const response = await fetch(OAUTH_REFRESH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: OAUTH_CLIENT_ID,
				client_secret: OAUTH_CLIENT_SECRET,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			this.initPromise = null; // Allow re-initialization
			throw new Error(`Token refresh failed: ${errorText}`);
		}

		const refreshData = (await response.json()) as TokenRefreshResponse;
		const expiryDate = Date.now() + (refreshData.expires_in * 1000);
		
		// Get existing refresh count from current cached data or KV
		let existingRefreshCount = this.cachedTokenData?.refresh_count || 0;
		if (existingRefreshCount === 0) {
			// Try to get refresh count from KV if not in memory
			const kvToken = await this.loadTokenFromKV();
			existingRefreshCount = kvToken?.refresh_count || 0;
		}
		
		// Create enhanced token data with incremented refresh count
		const tokenData = this.createTokenData(refreshData.access_token, expiryDate);
		tokenData.refresh_count = existingRefreshCount + 1;
		
		this.cachedTokenData = tokenData;
		await this.cacheTokenWithMetadata(tokenData);
		
		// Record token refresh in performance metrics
		const metricsCollector = PerformanceMetricsCollector.getInstance();
		metricsCollector.recordTokenRefresh();
		
		console.log(`Token refreshed successfully (refresh count: ${tokenData.refresh_count})`);
	}

	// Enhanced caching with metadata and intelligent TTL
	private async cacheTokenWithMetadata(tokenData: CachedTokenData): Promise<void> {
		try {
			const ttl = Math.floor((tokenData.expiry_date - Date.now()) / 1000);
			// Ensure TTL is within KV storage limits (max 32-bit signed integer)
			const safeTtl = Math.min(Math.max(ttl, 0), 2147483647);
			if (safeTtl > 0) {
				await this.env.GEMINI_CREDS_KV.put(KV_TOKEN_KEY, JSON.stringify(tokenData), { 
					expirationTtl: safeTtl 
				});
				console.log(`Token cached in KV with TTL of ${safeTtl}s, refresh_count: ${tokenData.refresh_count}, last_used: ${new Date(tokenData.last_used).toISOString()}`);
			}
		} catch (error) {
			console.warn("Failed to cache token in KV:", error);
		}
	}

	// Process pending requests after token refresh
	private processPendingRequests(): void {
		const requests = [...this.pendingRequests];
		this.pendingRequests = [];
		
		requests.forEach(request => {
			if (this.cachedTokenData && this.isTokenValid(this.cachedTokenData)) {
				request.resolve();
			} else {
				request.reject(new Error("Token refresh failed"));
			}
		});
	}

	// Queue requests during token refresh
	private async waitForTokenRefresh(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.pendingRequests.push({ resolve, reject });
		});
	}

	// Enhanced token access with validation and pre-refresh
	public async getAccessToken(): Promise<string> {
		await this.initialize();
		
		if (!this.cachedTokenData) {
			throw new Error("AuthManager not initialized or initialization failed.");
		}

		// Check if token needs pre-refresh
		if (!this.isTokenValid(this.cachedTokenData)) {
			// If refresh is in progress, wait for it
			if (this.refreshOperation) {
				await this.waitForTokenRefresh();
			} else {
				// Trigger background refresh
				const oauth2Creds: OAuth2Credentials = JSON.parse(this.env.GCP_SERVICE_ACCOUNT);
				await this.refreshToken(oauth2Creds.refresh_token);
			}
		}

		// Update last used timestamp
		this.cachedTokenData.last_used = Date.now();
		
		return this.cachedTokenData.access_token;
	}

	// Enhanced cache clearing with metadata cleanup
	public async clearTokenCache(): Promise<void> {
		this.cachedTokenData = null;
		this.initPromise = null;
		this.refreshOperation = null;
		this.pendingRequests = [];
		
		try {
			await this.env.GEMINI_CREDS_KV.delete(KV_TOKEN_KEY);
			console.log("Cleared cached token and metadata.");
		} catch (error) {
			console.warn("Failed to clear token cache:", error);
		}
	}

	// Enhanced endpoint calling with improved error handling
	public async callEndpoint(method: string, body: Record<string, unknown>, isRetry: boolean = false): Promise<any> {
		const accessToken = await this.getAccessToken();

		const response = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${accessToken}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			if (response.status === 401 && !isRetry) {
				console.log("Got 401 on API call, clearing cache and retrying...");
				await this.clearTokenCache();
				return this.callEndpoint(method, body, true); // Retry once
			}
			const errorText = await response.text();
			throw new Error(`API call to ${method} failed with status ${response.status}: ${errorText}`);
		}

		return response.json();
	}

	// Get cache performance metrics
	public getCacheMetrics(): { refreshCount: number; lastUsed: number; cacheAge: number } | null {
		if (!this.cachedTokenData) return null;
		
		return {
			refreshCount: this.cachedTokenData.refresh_count,
			lastUsed: this.cachedTokenData.last_used,
			cacheAge: Date.now() - this.cachedTokenData.created_at
		};
	}
}
