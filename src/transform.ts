const geminiPathRegex = /v1(?:beta)?\/models\/([^/:]+):(.+)/;

/**
 * Parses the model and action from a Gemini API path.
 */
export function parseGeminiPath(path: string): { model: string; action: string } | null {
    const matches = path.match(geminiPathRegex);
    if (!matches || matches.length < 3) {
        return null;
    }
    return { model: matches[1], action: matches[2] };
}

/**
 * Normalizes the model name to one supported by the Code Assist API.
 * Returns the normalized name and a boolean indicating if a change was made.
 */
export function normalizeModelName(model: string): { normalized: string; changed: boolean } {
    const lowerModel = model.toLowerCase();
    if (lowerModel.includes("pro")) {
        const normalized = "gemini-2.5-pro";
        return { normalized, changed: model !== normalized };
    }
    if (lowerModel.includes("flash")) {
        const normalized = "gemini-2.5-flash";
        return { normalized, changed: model !== normalized };
    }
    return { normalized: model, changed: false };
}

/**
 * Builds the request body for the Cloud Code API.
 */
export function buildCloudCodeRequestBody(
    originalBody: any,
    model: string,
    action: string,
    projectId: string
): Record<string, any> {
    if (action === "countTokens") {
        // Avoid mutating the original body by creating a new object.
        const innerRequest = { ...(originalBody.generateContentRequest ?? originalBody) };
        innerRequest.model = `models/${model}`;
        return { request: innerRequest };
    }

    return {
        model: model,
        project: projectId,
        request: originalBody,
    };
}

/**
 * Unwraps the Cloud Code response to the standard Gemini format.
 */
export function unwrapCloudCodeResponse(cloudCodeResp: any): any {
    if (cloudCodeResp.response) {
        // Merge the nested 'response' object with any other top-level fields
        return { ...cloudCodeResp, ...cloudCodeResp.response };
    }
    return cloudCodeResp;
}

/**
 * A transform stream that parses SSE events, unwraps the Cloud Code response,
 * and re-serializes them.
 */
export function createSSETransformStream(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const jsonData = line.substring(6);
                        const cloudCodeResp = JSON.parse(jsonData);
                        const geminiResp = unwrapCloudCodeResponse(cloudCodeResp);
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiResp)}\n`));
                    } catch (e) {
                        // If parsing fails, pass the original line through
                        controller.enqueue(encoder.encode(line + "\n"));
                    }
                } else {
                    controller.enqueue(encoder.encode(line + "\n"));
                }
            }
        },
        flush(controller) {
            if (buffer) {
                controller.enqueue(encoder.encode(buffer));
            }
        },
    });
}
