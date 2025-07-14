import { Env } from "./types";
import { AuthManager } from "./auth";
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from "./config";
import {
    parseGeminiPath,
    normalizeModelName,
    buildCloudCodeRequestBody,
    unwrapCloudCodeResponse,
    createSSETransformStream,
} from "./transform";

// Cache the discovered project ID to avoid repeated API calls
let cachedProjectId: string | null = null;

async function discoverProjectId(authManager: AuthManager, env: Env): Promise<string> {
    if (env.GEMINI_PROJECT_ID) {
        if (!cachedProjectId) {
            console.log(`Using project ID from environment: ${env.GEMINI_PROJECT_ID}`);
            cachedProjectId = env.GEMINI_PROJECT_ID;
        }
        return env.GEMINI_PROJECT_ID;
    }

    if (cachedProjectId) {
        return cachedProjectId;
    }

    console.log("Attempting to discover project ID via loadCodeAssist API call...");
    try {
        const initialProjectId = "default-project";
        const loadResponse = await authManager.callEndpoint("loadCodeAssist", {
            cloudaicompanionProject: initialProjectId,
            metadata: { duetProject: initialProjectId },
        });

        if (loadResponse && loadResponse.cloudaicompanionProject) {
            cachedProjectId = loadResponse.cloudaicompanionProject;
            console.log(`Discovered project ID: ${cachedProjectId}`);
            return cachedProjectId!;
        }

        throw new Error("Project ID not found in loadCodeAssist response.");
    } catch (error: any) {
        console.error("Failed to discover project ID:", error.message);
        throw new Error(
            "Could not discover project ID. Make sure you're authenticated and consider setting the GEMINI_PROJECT_ID environment variable."
        );
    }
}

export async function handleProxy(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathInfo = parseGeminiPath(url.pathname);

    if (!pathInfo) {
        return new Response("Invalid Gemini API path", { status: 400 });
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

    const authManager = new AuthManager(env);

    try {
        await authManager.initialize();

        const [accessToken, originalBody] = await Promise.all([
            authManager.getAccessToken(),
            request.json(),
        ]);

        const projectId = await discoverProjectId(authManager, env);

        const targetUrl = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${action}${url.search}`;
        const cloudCodeBody = buildCloudCodeRequestBody(originalBody, model, action, projectId);

        const proxyHeaders = new Headers(request.headers);
        proxyHeaders.set("Authorization", `Bearer ${accessToken}`);
        proxyHeaders.set("Content-Type", "application/json");
        proxyHeaders.set("x-goog-api-client", "gemini-proxy-worker/1.0");
        proxyHeaders.delete("Host");

        const proxyRequest = new Request(targetUrl, {
            method: "POST",
            headers: proxyHeaders,
            body: JSON.stringify(cloudCodeBody),
        });

        const proxyResponse = await fetch(proxyRequest);

        if (!proxyResponse.ok) {
            console.error(`Upstream API error: ${proxyResponse.status} ${proxyResponse.statusText}`);
            const errorBody = await proxyResponse.text();
            console.error(`Upstream error body: ${errorBody}`);
            return new Response(errorBody, {
                status: proxyResponse.status,
                statusText: proxyResponse.statusText,
                headers: proxyResponse.headers,
            });
        }

        if (proxyResponse.headers.get("Content-Type")?.includes("text/event-stream")) {
            if (!proxyResponse.body) {
                return new Response("Upstream response has no body", { status: 500 });
            }
            const transformStream = createSSETransformStream();
            const body = proxyResponse.body.pipeThrough(transformStream);
            return new Response(body, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            });
        }

        const responseBody = await proxyResponse.json();
        const unwrappedBody = unwrapCloudCodeResponse(responseBody);

        return new Response(JSON.stringify(unwrappedBody), {
            status: proxyResponse.status,
            headers: { "Content-Type": "application/json" },
        });

    } catch (e: any) {
        console.error("Error in proxy handler:", e);
        return new Response(e.message, { status: 500 });
    }
}
