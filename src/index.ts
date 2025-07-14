import { Hono } from "hono";
import { Env } from "./types";
import { handleProxy } from "./handler";

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use("*", async (c, next) => {
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (c.req.method === "OPTIONS") {
		return c.body(null, 204);
	}
	await next();
});

// The proxy route
app.post("/v1beta/models/:model_and_action", async (c) => {
    return handleProxy(c.req.raw, c.env);
});

app.post("/v1/models/:model_and_action", async (c) => {
    return handleProxy(c.req.raw, c.env);
});


// Root endpoint for basic info
app.get("/", (c) => {
	return c.json({
		name: "Gemini Proxy Worker",
		description: "A Cloudflare Worker to proxy Gemini API requests to the Code Assist API.",
		version: "1.0.0",
	});
});

export default app;
