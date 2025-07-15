import { Env } from "./types";
import { AuthManager } from "./auth";
import { 
    CODE_ASSIST_ENDPOINT, 
    CODE_ASSIST_API_VERSION,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_TIMEOUT_MS,
    CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    MAX_RETRY_ATTEMPTS,
    BASE_RETRY_DELAY_MS,
    MAX_RETRY_DELAY_MS,
    RETRY_JITTER_FACTOR
} from "./config";
import { ConnectionPool } from "./connection-pool";
import { RequestContextManager } from "./request-context";
import { ProjectCacheManager } from "./project-cache";
import { CircuitBreaker, RetryManager } from "./circuit-breaker";
import { ErrorHandler, ErrorLogger, ErrorType } from "./error-handler";
import {
    parseGeminiPath,
    normalizeModelName,
    buildCloudCodeRequestBody,
    unwrapCloudCodeResponse,
    createSSETransformStream,
} from "./transform";



export async function handleProxy(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathInfo = parseGeminiPath(url.pathname);

    if (!pathInfo) {
        const classification = ErrorHandler.classifyError("Invalid Gemini API path", 400);
        return ErrorHandler.createErrorResponse(classification);
    }

    // Strip the API key from the query params, as we're using OAuth
    if (url.searchParams.has("key")) {
        url.searchParams.delete("key");
    }

    const { model: originalModel, action } = pathInfo;
    const { normalized: model, changed } = normalizeModelName(originalModel);
    if (changed) {
        console.log(`Normalized model name from '${originalModel}' to '${model}'`);
    }

    // Create request context for performance tracking
    const isStreaming = url.searchParams.has("stream") || action.includes("stream");
    const clientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For");
    const userAgent = request.headers.get("User-Agent");
    
    const context = RequestContextManager.createContext(
        model,
        action,
        isStreaming,
        clientIP || undefined,
        userAgent || undefined
    );

    ErrorLogger.logInfo(`Starting request: ${model}:${action}`, 'REQUEST_START', context.requestId);

    // Initialize circuit breaker for upstream calls
    const circuitBreaker = CircuitBreaker.getInstance('upstream-api', {
        failureThreshold: parseInt(env.CIRCUIT_BREAKER_THRESHOLD || CIRCUIT_BREAKER_FAILURE_THRESHOLD.toString()),
        timeoutMs: parseInt(env.CIRCUIT_BREAKER_TIMEOUT_MS || CIRCUIT_BREAKER_TIMEOUT_MS.toString()),
        halfOpenMaxCalls: CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS,
        resetTimeoutMs: CIRCUIT_BREAKER_RESET_TIMEOUT_MS
    });

    const authManager = AuthManager.getInstance(env);

    try {
        // Parse request body early to fail fast on malformed JSON
        let originalBody: any;
        try {
            originalBody = await request.json();
        } catch (jsonError) {
            const classification = ErrorHandler.classifyError("Invalid JSON in request body", 400, context.requestId);
            RequestContextManager.completeRequest(context, true, 400);
            return ErrorHandler.createErrorResponse(classification, context.requestId);
        }

        // Execute main request logic with retry and circuit breaker
        const response = await executeRequestWithRetry(
            async () => {
                return await processProxyRequest(
                    authManager,
                    context,
                    env,
                    url,
                    action,
                    model,
                    originalBody,
                    circuitBreaker,
                    isStreaming
                );
            },
            context.requestId,
            authManager
        );

        RequestContextManager.completeRequest(context, false, response.status);
        return response;

    } catch (error: any) {
        const classification = ErrorHandler.classifyError(error, undefined, context.requestId);
        ErrorLogger.logError(error, 'PROXY_HANDLER_ERROR', context.requestId);
        RequestContextManager.completeRequest(context, true, classification.statusCode);
        
        if (isStreaming) {
            return ErrorHandler.createStreamingErrorResponse(classification, context.requestId);
        }
        return ErrorHandler.createErrorResponse(classification, context.requestId);
    }
}

async function processProxyRequest(
    authManager: AuthManager,
    context: any,
    env: Env,
    url: URL,
    action: string,
    model: string,
    originalBody: any,
    circuitBreaker: CircuitBreaker,
    isStreaming: boolean
): Promise<Response> {
    // Start authentication timing
    RequestContextManager.startTiming(context, 'authStart');
    await authManager.initialize();

    const accessToken = await authManager.getAccessToken();
    RequestContextManager.endTiming(context, 'authEnd');

    const projectId = await ProjectCacheManager.getProjectId(authManager, env, context.requestId);

    // Start transform timing
    RequestContextManager.startTiming(context, 'transformStart');
    const targetUrl = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${action}${url.search}`;
    const cloudCodeBody = buildCloudCodeRequestBody(originalBody, model, action, projectId);
    RequestContextManager.endTiming(context, 'transformEnd');

    const proxyHeaders = new Headers();
    proxyHeaders.set("Authorization", `Bearer ${accessToken}`);
    proxyHeaders.set("Content-Type", "application/json");
    proxyHeaders.set("x-goog-api-client", "gemini-proxy-worker/1.0");

    // Start upstream timing
    RequestContextManager.startTiming(context, 'upstreamStart');
    
    // Execute upstream call with circuit breaker protection
    const proxyResponse = await circuitBreaker.execute(async () => {
        const connectionPool = ConnectionPool.getInstance();
        return await RetryManager.executeWithRateLimitRespect(
            () => connectionPool.fetch(targetUrl, {
                method: "POST",
                headers: proxyHeaders,
                body: JSON.stringify(cloudCodeBody),
            }),
            MAX_RETRY_ATTEMPTS
        );
    });
    
    RequestContextManager.endTiming(context, 'upstreamEnd');

    if (!proxyResponse.ok) {
        const classification = ErrorHandler.classifyError(proxyResponse, proxyResponse.status, context.requestId);
        const errorBody = await proxyResponse.text();
        ErrorLogger.logError(
            `Upstream API error: ${proxyResponse.status} ${proxyResponse.statusText}`,
            'UPSTREAM_ERROR',
            context.requestId,
            { errorBody: errorBody.substring(0, 500) } // Limit error body size in logs
        );
        
        if (isStreaming) {
            return ErrorHandler.createStreamingErrorResponse(classification, context.requestId);
        }
        return ErrorHandler.createErrorResponse(classification, context.requestId);
    }

    if (proxyResponse.headers.get("Content-Type")?.includes("text/event-stream")) {
        if (!proxyResponse.body) {
            const classification = ErrorHandler.classifyError("Upstream response has no body", 500, context.requestId);
            return ErrorHandler.createStreamingErrorResponse(classification, context.requestId);
        }
        const transformStream = createSSETransformStream();
        const body = proxyResponse.body.pipeThrough(transformStream);
        
        return new Response(body, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Request-ID": context.requestId
            },
        });
    }

    const responseBody = await proxyResponse.json();
    const unwrappedBody = unwrapCloudCodeResponse(responseBody);

    return new Response(JSON.stringify(unwrappedBody), {
        status: proxyResponse.status,
        headers: { 
            "Content-Type": "application/json",
            "X-Request-ID": context.requestId
        },
    });
}

async function executeRequestWithRetry(
    operation: () => Promise<Response>,
    requestId: string,
    authManager: AuthManager,
    maxRetries: number = 1
): Promise<Response> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            const classification = ErrorHandler.classifyError(error, undefined, requestId);
            
            // Only retry for authentication errors and only once
            if (classification.type === ErrorType.AUTH_ERROR && attempt < maxRetries) {
                ErrorLogger.logWarning(
                    `Authentication error on attempt ${attempt + 1}, clearing cache and retrying`,
                    'AUTH_RETRY',
                    requestId
                );
                
                // Clear token cache and retry
                await authManager.clearTokenCache();
                continue;
            }
            
            // Don't retry for other error types in the main handler
            break;
        }
    }
    
    throw lastError;
}
