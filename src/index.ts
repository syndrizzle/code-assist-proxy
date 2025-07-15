import { Hono } from "hono";
import { Env } from "./types";
import { handleProxy } from "./handler";
import { HealthMonitor } from "./health-monitor";
import { DeploymentValidator } from "./deployment-validator";

const app = new Hono<{ Bindings: Env }>();

// Global startup validation flag
let startupValidationCompleted = false;
let startupValidationResult: { success: boolean; criticalErrors: string[]; warnings: string[]; recommendations: string[] } | null = null;

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

// Startup validation middleware - runs on first request
app.use("*", async (c, next) => {
	if (!startupValidationCompleted) {
		console.log('🔍 Performing startup validation on first request...');
		const deploymentValidator = DeploymentValidator.getInstance();
		startupValidationResult = await deploymentValidator.performStartupValidation(c.env);
		startupValidationCompleted = true;
		
		// If critical errors exist, we can still continue but log them
		if (!startupValidationResult.success) {
			console.error('⚠️  Worker started with validation errors - some functionality may be limited');
		}
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


// Health check endpoints
app.get("/health", async (c) => {
	const healthMonitor = HealthMonitor.getInstance();
	return healthMonitor.createHealthCheckResponse(c.env, false);
});

app.get("/health/detailed", async (c) => {
	const healthMonitor = HealthMonitor.getInstance();
	return healthMonitor.createHealthCheckResponse(c.env, true);
});

// Metrics endpoints
app.get("/metrics", async (c) => {
	const healthMonitor = HealthMonitor.getInstance();
	const format = c.req.query('format') as 'json' | 'prometheus' || 'json';
	return healthMonitor.createMetricsResponse(c.env, format);
});

app.get("/metrics/prometheus", async (c) => {
	const healthMonitor = HealthMonitor.getInstance();
	return healthMonitor.createMetricsResponse(c.env, 'prometheus');
});

// Deployment validation endpoints
app.get("/deployment/validate", async (c) => {
	const deploymentValidator = DeploymentValidator.getInstance();
	return deploymentValidator.createValidationResponse(c.env);
});

app.get("/deployment/bindings", async (c) => {
	const deploymentValidator = DeploymentValidator.getInstance();
	try {
		const bindingCheck = await deploymentValidator.validateDeploymentBindings(c.env);
		const statusCode = bindingCheck.status === 'pass' ? 200 : 
		                  bindingCheck.status === 'warning' ? 200 : 500;
		
		return c.json({
			timestamp: Date.now(),
			bindingValidation: bindingCheck,
			startupValidation: startupValidationResult
		}, statusCode);
	} catch (error) {
		return c.json({
			timestamp: Date.now(),
			error: 'Deployment binding validation failed',
			message: error instanceof Error ? error.message : 'Unknown error'
		}, 500);
	}
});

app.get("/deployment/status", async (c) => {
	return c.json({
		timestamp: Date.now(),
		startupValidationCompleted,
		startupValidation: startupValidationResult,
		workerStatus: startupValidationResult?.success ? 'operational' : 'degraded'
	});
});

// Root endpoint for basic info
app.get("/", (c) => {
	return c.json({
		name: "Gemini Proxy Worker",
		description: "A Cloudflare Worker to proxy Gemini API requests to the Code Assist API.",
		version: "1.0.0",
		endpoints: {
			proxy: ["/v1/models/*", "/v1beta/models/*"],
			monitoring: ["/health", "/health/detailed", "/metrics", "/metrics/prometheus"],
			deployment: ["/deployment/validate", "/deployment/bindings", "/deployment/status"]
		},
		startupValidation: startupValidationCompleted ? {
			completed: true,
			success: startupValidationResult?.success,
			criticalErrors: startupValidationResult?.criticalErrors?.length || 0,
			warnings: startupValidationResult?.warnings?.length || 0
		} : {
			completed: false,
			message: "Startup validation will run on first request"
		}
	});
});

export default app;
