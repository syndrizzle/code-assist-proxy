import { Env, ProjectCache } from "./types";
import { AuthManager } from "./auth";
import { RequestContextManager } from "./request-context";
import { PROJECT_ID_CACHE_KEY, PROJECT_ID_CACHE_TTL, PROJECT_ID_VALIDATION_INTERVAL } from "./config";

export class ProjectCacheManager {
    private static memoryCache: ProjectCache | null = null;
    private static lastValidation: number = 0;

    /**
     * Get project ID with caching and fallback mechanisms
     */
    public static async getProjectId(authManager: AuthManager, env: Env, requestId?: string): Promise<string> {
        const logPrefix = requestId ? `[${requestId}]` : '';

        // First, try environment variable
        if (env.GEMINI_PROJECT_ID) {
            if (!this.memoryCache || this.memoryCache.source !== 'environment') {
                console.log(`${logPrefix} Using project ID from environment: ${env.GEMINI_PROJECT_ID}`);
                this.memoryCache = {
                    project_id: env.GEMINI_PROJECT_ID,
                    discovered_at: Date.now(),
                    ttl: Date.now() + PROJECT_ID_CACHE_TTL,
                    source: 'environment',
                    validation_count: 0,
                };
            }
            return env.GEMINI_PROJECT_ID;
        }

        // Check memory cache first
        if (this.memoryCache && this.isCacheValid(this.memoryCache)) {
            console.log(`${logPrefix} Using cached project ID: ${this.memoryCache.project_id}`);
            return this.memoryCache.project_id;
        }

        // Try KV cache
        try {
            const kvCached = await this.getFromKV(env);
            if (kvCached && this.isCacheValid(kvCached)) {
                console.log(`${logPrefix} Retrieved project ID from KV cache: ${kvCached.project_id}`);
                this.memoryCache = kvCached;
                return kvCached.project_id;
            }
        } catch (error) {
            console.warn(`${logPrefix} Failed to retrieve from KV cache:`, error);
        }

        // Discover project ID via API
        console.log(`${logPrefix} Attempting to discover project ID via loadCodeAssist API call...`);
        try {
            const discoveredProjectId = await this.discoverProjectId(authManager);
            
            // Cache the discovered project ID
            const projectCache: ProjectCache = {
                project_id: discoveredProjectId,
                discovered_at: Date.now(),
                ttl: Date.now() + PROJECT_ID_CACHE_TTL,
                source: 'discovery',
                validation_count: 1,
            };

            // Store in memory and KV
            this.memoryCache = projectCache;
            await this.storeInKV(env, projectCache);

            console.log(`${logPrefix} Discovered and cached project ID: ${discoveredProjectId}`);
            return discoveredProjectId;

        } catch (error: any) {
            console.error(`${logPrefix} Failed to discover project ID:`, error.message);
            
            // Try to use expired cache as fallback
            if (this.memoryCache) {
                console.warn(`${logPrefix} Using expired cached project ID as fallback: ${this.memoryCache.project_id}`);
                return this.memoryCache.project_id;
            }

            throw new Error(
                "Could not discover project ID. Make sure you're authenticated and consider setting the GEMINI_PROJECT_ID environment variable."
            );
        }
    }

    /**
     * Validate cached project ID periodically
     */
    public static async validateCachedProjectId(authManager: AuthManager, env: Env): Promise<boolean> {
        if (!this.memoryCache) {
            return false;
        }

        const now = Date.now();
        if (now - this.lastValidation < PROJECT_ID_VALIDATION_INTERVAL) {
            return true; // Skip validation if done recently
        }

        try {
            // Try to use the cached project ID in a test call
            const testResponse = await authManager.callEndpoint("loadCodeAssist", {
                cloudaicompanionProject: this.memoryCache.project_id,
                metadata: { duetProject: this.memoryCache.project_id },
            });

            if (testResponse && testResponse.cloudaicompanionProject === this.memoryCache.project_id) {
                this.lastValidation = now;
                this.memoryCache.validation_count++;
                console.log(`Validated cached project ID: ${this.memoryCache.project_id}`);
                return true;
            }

            // Cache is invalid, clear it
            console.warn(`Cached project ID validation failed, clearing cache`);
            this.clearCache(env);
            return false;

        } catch (error) {
            console.warn(`Project ID validation failed:`, error);
            return false;
        }
    }

    /**
     * Discover project ID via API call
     */
    private static async discoverProjectId(authManager: AuthManager): Promise<string> {
        const initialProjectId = "default-project";
        const loadResponse = await authManager.callEndpoint("loadCodeAssist", {
            cloudaicompanionProject: initialProjectId,
            metadata: { duetProject: initialProjectId },
        });

        if (loadResponse && loadResponse.cloudaicompanionProject) {
            return loadResponse.cloudaicompanionProject;
        }

        throw new Error("Project ID not found in loadCodeAssist response.");
    }

    /**
     * Check if cache entry is valid
     */
    private static isCacheValid(cache: ProjectCache): boolean {
        const now = Date.now();
        return now < cache.ttl;
    }

    /**
     * Get project cache from KV storage
     */
    private static async getFromKV(env: Env): Promise<ProjectCache | null> {
        try {
            const cached = await env.GEMINI_CREDS_KV.get(PROJECT_ID_CACHE_KEY, "json");
            return cached as ProjectCache | null;
        } catch (error) {
            console.warn("Failed to get project cache from KV:", error);
            return null;
        }
    }

    /**
     * Store project cache in KV storage
     */
    private static async storeInKV(env: Env, cache: ProjectCache): Promise<void> {
        try {
            const ttlSeconds = Math.floor((cache.ttl - Date.now()) / 1000);
            if (ttlSeconds > 0) {
                await env.GEMINI_CREDS_KV.put(
                    PROJECT_ID_CACHE_KEY,
                    JSON.stringify(cache),
                    { expirationTtl: ttlSeconds }
                );
            }
        } catch (error) {
            console.warn("Failed to store project cache in KV:", error);
        }
    }

    /**
     * Clear all caches
     */
    public static async clearCache(env: Env): Promise<void> {
        this.memoryCache = null;
        this.lastValidation = 0;
        
        try {
            await env.GEMINI_CREDS_KV.delete(PROJECT_ID_CACHE_KEY);
        } catch (error) {
            console.warn("Failed to clear project cache from KV:", error);
        }
    }

    /**
     * Get cache statistics
     */
    public static getCacheStats(): {
        hasMemoryCache: boolean;
        cacheSource: string | null;
        cacheAge: number;
        validationCount: number;
        isExpired: boolean;
    } {
        if (!this.memoryCache) {
            return {
                hasMemoryCache: false,
                cacheSource: null,
                cacheAge: 0,
                validationCount: 0,
                isExpired: false,
            };
        }

        const now = Date.now();
        return {
            hasMemoryCache: true,
            cacheSource: this.memoryCache.source,
            cacheAge: now - this.memoryCache.discovered_at,
            validationCount: this.memoryCache.validation_count,
            isExpired: now >= this.memoryCache.ttl,
        };
    }

    /**
     * Force refresh project ID cache
     */
    public static async forceRefresh(authManager: AuthManager, env: Env): Promise<string> {
        await this.clearCache(env);
        return this.getProjectId(authManager, env);
    }
}