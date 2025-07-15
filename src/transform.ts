const geminiPathRegex = /v1(?:beta)?\/models\/([^/:]+):(.+)/;

// Model name normalization cache for performance optimization
const modelNormalizationCache = new Map<string, { normalized: string; changed: boolean }>();

// Model name mapping for efficient lookup
const modelMappings = new Map<string, string>([
    // Gemini Pro variants
    ['gemini-pro', 'gemini-2.5-pro'],
    ['gemini-1.5-pro', 'gemini-2.5-pro'],
    ['gemini-2.0-pro', 'gemini-2.5-pro'],
    ['gemini-2.5-pro', 'gemini-2.5-pro'],
    
    // Gemini Flash variants
    ['gemini-flash', 'gemini-2.5-flash'],
    ['gemini-1.5-flash', 'gemini-2.5-flash'],
    ['gemini-2.0-flash', 'gemini-2.5-flash'],
    ['gemini-2.5-flash', 'gemini-2.5-flash'],
    
    // Additional aliases and variants
    ['gemini-pro-latest', 'gemini-2.5-pro'],
    ['gemini-flash-latest', 'gemini-2.5-flash'],
    ['gemini-pro-experimental', 'gemini-2.5-pro'],
    ['gemini-flash-experimental', 'gemini-2.5-flash'],
]);

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
 * Normalizes the model name to one supported by the Code Assist API with caching.
 * Returns the normalized name and a boolean indicating if a change was made.
 */
export function normalizeModelName(model: string): { normalized: string; changed: boolean } {
    // Check cache first for performance
    const cached = modelNormalizationCache.get(model);
    if (cached) {
        return cached;
    }
    
    let result: { normalized: string; changed: boolean };
    
    // Try exact mapping first (most efficient)
    const exactMatch = modelMappings.get(model.toLowerCase());
    if (exactMatch) {
        result = { normalized: exactMatch, changed: model !== exactMatch };
    } else {
        // Fallback to pattern matching for unknown variants
        const lowerModel = model.toLowerCase();
        if (lowerModel.includes("pro")) {
            const normalized = "gemini-2.5-pro";
            result = { normalized, changed: model !== normalized };
        } else if (lowerModel.includes("flash")) {
            const normalized = "gemini-2.5-flash";
            result = { normalized, changed: model !== normalized };
        } else {
            // Unknown model - pass through unchanged
            result = { normalized: model, changed: false };
        }
    }
    
    // Cache the result for future lookups
    modelNormalizationCache.set(model, result);
    
    // Prevent cache from growing too large (keep most recent 1000 entries)
    if (modelNormalizationCache.size > 1000) {
        const firstKey = modelNormalizationCache.keys().next().value;
        if (firstKey !== undefined) {
            modelNormalizationCache.delete(firstKey);
        }
    }
    
    return result;
}

/**
 * Clears the model normalization cache. Useful for testing or memory management.
 */
export function clearModelNormalizationCache(): void {
    modelNormalizationCache.clear();
}

/**
 * Gets the current size of the model normalization cache.
 */
export function getModelNormalizationCacheSize(): number {
    return modelNormalizationCache.size;
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
 * Streaming JSON parser for large response bodies with memory efficiency.
 * Handles truncated or incomplete JSON responses gracefully.
 */
export function createJSONTransformStream(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let braceDepth = 0;
    let inString = false;
    let escapeNext = false;
    let jsonStart = -1;

    return new TransformStream({
        transform(chunk, controller) {
            try {
                const text = decoder.decode(chunk, { stream: true });
                buffer += text;
                
                let i = 0;
                while (i < buffer.length) {
                    const char = buffer[i];
                    
                    if (escapeNext) {
                        escapeNext = false;
                        i++;
                        continue;
                    }
                    
                    if (char === '\\' && inString) {
                        escapeNext = true;
                        i++;
                        continue;
                    }
                    
                    if (char === '"') {
                        inString = !inString;
                        i++;
                        continue;
                    }
                    
                    if (!inString) {
                        if (char === '{') {
                            if (braceDepth === 0) {
                                jsonStart = i;
                            }
                            braceDepth++;
                        } else if (char === '}') {
                            braceDepth--;
                            if (braceDepth === 0 && jsonStart !== -1) {
                                // Complete JSON object found
                                const jsonStr = buffer.slice(jsonStart, i + 1);
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const transformed = unwrapCloudCodeResponse(parsed);
                                    controller.enqueue(encoder.encode(JSON.stringify(transformed)));
                                    
                                    // Remove processed JSON from buffer
                                    buffer = buffer.slice(i + 1);
                                    i = -1; // Reset counter since buffer changed
                                    jsonStart = -1;
                                } catch (parseError) {
                                    // Invalid JSON - pass through original
                                    console.warn('Large JSON parse error:', parseError);
                                    controller.enqueue(encoder.encode(jsonStr));
                                    buffer = buffer.slice(i + 1);
                                    i = -1;
                                    jsonStart = -1;
                                }
                            }
                        }
                    }
                    
                    i++;
                }
                
                // Prevent buffer from growing too large (max 1MB)
                if (buffer.length > 1024 * 1024) {
                    console.warn('JSON buffer too large, truncating');
                    // Try to salvage partial JSON if possible
                    if (jsonStart !== -1 && jsonStart < buffer.length / 2) {
                        const partialJson = buffer.slice(jsonStart);
                        try {
                            // Attempt to close incomplete JSON
                            const closedJson = partialJson + '}'.repeat(braceDepth);
                            const parsed = JSON.parse(closedJson);
                            const transformed = unwrapCloudCodeResponse(parsed);
                            controller.enqueue(encoder.encode(JSON.stringify(transformed)));
                        } catch {
                            // If that fails, pass through as-is
                            controller.enqueue(encoder.encode(partialJson));
                        }
                    }
                    buffer = "";
                    braceDepth = 0;
                    inString = false;
                    escapeNext = false;
                    jsonStart = -1;
                }
                
            } catch (error) {
                console.error('JSON transform error:', error);
                controller.error(new Error(`JSON stream transform failed: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
        
        flush(controller) {
            try {
                if (buffer.length > 0) {
                    if (jsonStart !== -1) {
                        // Handle incomplete JSON at end of stream
                        const partialJson = buffer.slice(jsonStart);
                        try {
                            // Try to parse as-is first
                            const parsed = JSON.parse(partialJson);
                            const transformed = unwrapCloudCodeResponse(parsed);
                            controller.enqueue(encoder.encode(JSON.stringify(transformed)));
                        } catch {
                            try {
                                // Try to close incomplete JSON
                                const closedJson = partialJson + '}'.repeat(braceDepth);
                                const parsed = JSON.parse(closedJson);
                                const transformed = unwrapCloudCodeResponse(parsed);
                                controller.enqueue(encoder.encode(JSON.stringify(transformed)));
                            } catch {
                                // If all else fails, pass through original
                                console.warn('Unable to parse incomplete JSON, passing through');
                                controller.enqueue(encoder.encode(partialJson));
                            }
                        }
                    } else {
                        // Non-JSON content at end
                        controller.enqueue(encoder.encode(buffer));
                    }
                }
            } catch (error) {
                console.error('JSON flush error:', error);
                controller.error(new Error(`JSON stream flush failed: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
    });
}

/**
 * A transform stream that parses SSE events, unwraps the Cloud Code response,
 * and re-serializes them with optimized memory usage and error handling.
 */
export function createSSETransformStream(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    
    // Pre-encoded constants to avoid repeated encoding
    const dataPrefix = encoder.encode("data: ");
    const newline = encoder.encode("\n");
    const dataPrefixStr = "data: ";

    return new TransformStream({
        transform(chunk, controller) {
            try {
                // Decode chunk with streaming flag for proper handling of multi-byte characters
                const text = decoder.decode(chunk, { stream: true });
                buffer += text;
                
                // Find line boundaries efficiently
                let lineStart = 0;
                let lineEnd = buffer.indexOf('\n', lineStart);
                
                while (lineEnd !== -1) {
                    const line = buffer.slice(lineStart, lineEnd);
                    
                    // Process SSE data lines with minimal string operations
                    if (line.length > 6 && line.charCodeAt(0) === 100 && // 'd'
                        line.charCodeAt(1) === 97 && // 'a'
                        line.charCodeAt(2) === 116 && // 't'
                        line.charCodeAt(3) === 97 && // 'a'
                        line.charCodeAt(4) === 58 && // ':'
                        line.charCodeAt(5) === 32) { // ' '
                        
                        try {
                            const jsonData = line.slice(6); // Extract JSON without substring allocation
                            
                            // Fast check for empty data lines
                            if (jsonData.length === 0) {
                                controller.enqueue(dataPrefix);
                                controller.enqueue(newline);
                            } else {
                                const cloudCodeResp = JSON.parse(jsonData);
                                const geminiResp = unwrapCloudCodeResponse(cloudCodeResp);
                                
                                // Use pre-encoded prefix and encode JSON separately
                                controller.enqueue(dataPrefix);
                                controller.enqueue(encoder.encode(JSON.stringify(geminiResp)));
                                controller.enqueue(newline);
                            }
                        } catch (parseError) {
                            // Handle malformed JSON gracefully - pass through original line
                            console.warn('SSE JSON parse error:', parseError);
                            controller.enqueue(encoder.encode(line));
                            controller.enqueue(newline);
                        }
                    } else {
                        // Non-data lines (comments, event types, etc.) - pass through
                        controller.enqueue(encoder.encode(line));
                        controller.enqueue(newline);
                    }
                    
                    lineStart = lineEnd + 1;
                    lineEnd = buffer.indexOf('\n', lineStart);
                }
                
                // Keep remaining partial line in buffer
                buffer = buffer.slice(lineStart);
                
            } catch (decodeError) {
                // Handle decoder errors gracefully
                console.error('SSE decode error:', decodeError);
                controller.error(new Error(`SSE stream decode failed: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`));
            }
        },
        
        flush(controller) {
            try {
                // Process any remaining data in buffer
                if (buffer.length > 0) {
                    // Handle final line that might not end with newline
                    if (buffer.startsWith(dataPrefixStr)) {
                        try {
                            const jsonData = buffer.slice(6);
                            if (jsonData.length > 0) {
                                const cloudCodeResp = JSON.parse(jsonData);
                                const geminiResp = unwrapCloudCodeResponse(cloudCodeResp);
                                controller.enqueue(dataPrefix);
                                controller.enqueue(encoder.encode(JSON.stringify(geminiResp)));
                                controller.enqueue(newline);
                            }
                        } catch (parseError) {
                            console.warn('SSE final JSON parse error:', parseError);
                            controller.enqueue(encoder.encode(buffer));
                        }
                    } else {
                        controller.enqueue(encoder.encode(buffer));
                    }
                }
            } catch (flushError) {
                console.error('SSE flush error:', flushError);
                controller.error(new Error(`SSE stream flush failed: ${flushError instanceof Error ? flushError.message : String(flushError)}`));
            }
        },
    });
}
