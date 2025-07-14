// --- Environment Variable Typings ---
export interface Env {
	GCP_SERVICE_ACCOUNT: string; // Contains OAuth2 credentials JSON
	GEMINI_PROJECT_ID?: string;
	GEMINI_CREDS_KV: KVNamespace; // Cloudflare KV for token caching
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
