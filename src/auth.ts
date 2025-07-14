import { Env, OAuth2Credentials } from "./types";
import {
	OAUTH_CLIENT_ID,
	OAUTH_CLIENT_SECRET,
	OAUTH_REFRESH_URL,
	TOKEN_BUFFER_TIME,
	KV_TOKEN_KEY
} from "./config";

interface TokenRefreshResponse {
	access_token: string;
	expires_in: number;
}

interface CachedTokenData {
	access_token: string;
	expiry_date: number;
}

export class AuthManager {
	private env: Env;
	private accessToken: string | null = null;
	private initPromise: Promise<void> | null = null;

	constructor(env: Env) {
		this.env = env;
	}

	public initialize(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this._initialize();
		}
		return this.initPromise;
	}

	private async _initialize(): Promise<void> {
		if (this.accessToken) return;

		if (!this.env.GCP_SERVICE_ACCOUNT) {
			throw new Error("`GCP_SERVICE_ACCOUNT` environment variable not set.");
		}

		// 1. Try to get a cached token from KV
		const cached = await this.env.GEMINI_CREDS_KV.get<CachedTokenData>(KV_TOKEN_KEY, "json");
		if (cached && cached.expiry_date - Date.now() > TOKEN_BUFFER_TIME) {
			console.log("Using cached token.");
			this.accessToken = cached.access_token;
			return;
		}

		// 2. If no valid cached token, use the one from the environment
		const oauth2Creds: OAuth2Credentials = JSON.parse(this.env.GCP_SERVICE_ACCOUNT);
		const timeUntilExpiry = (oauth2Creds.expiry_date * 1000) - Date.now();

		if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
			console.log("Using token from environment.");
			this.accessToken = oauth2Creds.access_token;
			await this.cacheToken(this.accessToken, oauth2Creds.expiry_date);
			return;
		}

		// 3. If the token is expired, refresh it
		console.log("Token expired, refreshing...");
		await this.refreshAndCacheToken(oauth2Creds.refresh_token);
	}

	private async refreshAndCacheToken(refreshToken: string): Promise<void> {
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
		this.accessToken = refreshData.access_token;
		await this.cacheToken(this.accessToken, expiryDate);
	}

	private async cacheToken(accessToken: string, expiryDate: number): Promise<void> {
		const tokenData: CachedTokenData = { access_token: accessToken, expiry_date: expiryDate };
		const ttl = Math.floor((expiryDate - Date.now()) / 1000);
		if (ttl > 0) {
			await this.env.GEMINI_CREDS_KV.put(KV_TOKEN_KEY, JSON.stringify(tokenData), { expirationTtl: ttl });
			console.log(`Token cached in KV with TTL of ${ttl}s`);
		}
	}

	public getAccessToken(): string {
		if (!this.accessToken) {
			throw new Error("AuthManager not initialized or initialization failed.");
		}
		return this.accessToken;
	}

	public async clearTokenCache(): Promise<void> {
		this.accessToken = null;
		this.initPromise = null;
		await this.env.GEMINI_CREDS_KV.delete(KV_TOKEN_KEY);
		console.log("Cleared cached token.");
	}

	public async callEndpoint(method: string, body: Record<string, unknown>, isRetry: boolean = false): Promise<any> {
		await this.initialize();
		const accessToken = this.getAccessToken();

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
}
