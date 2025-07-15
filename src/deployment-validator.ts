import { Env } from "./types";
import { AuthManager } from "./auth";
import { ProjectCacheManager } from "./project-cache";

export interface DeploymentValidationResult {
    isValid: boolean;
    timestamp: number;
    checks: {
        environment: DeploymentCheckStatus;
        kvNamespace: DeploymentCheckStatus;
        authentication: DeploymentCheckStatus;
        projectDiscovery: DeploymentCheckStatus;
        configuration: DeploymentCheckStatus;
    };
    warnings: string[];
    errors: string[];
    recommendations: string[];
}

export interface DeploymentCheckStatus {
    status: 'pass' | 'warning' | 'fail';
    message: string;
    details?: string;
}

export class DeploymentValidator {
    private static instance: DeploymentValidator;

    private constructor() {}

    public static getInstance(): DeploymentValidator {
        if (!DeploymentValidator.instance) {
            DeploymentValidator.instance = new DeploymentValidator();
        }
        return DeploymentValidator.instance;
    }

    /**
     * Perform comprehensive deployment validation
     */
    public async validateDeployment(env: Env): Promise<DeploymentValidationResult> {
        const checks = {
            environment: await this.checkEnvironmentVariables(env),
            kvNamespace: await this.checkKVNamespace(env),
            authentication: await this.checkAuthenticationFlow(env),
            projectDiscovery: await this.checkProjectDiscovery(env),
            configuration: await this.checkConfiguration(env),
        };

        const warnings: string[] = [];
        const errors: string[] = [];
        const recommendations: string[] = [];

        // Collect warnings, errors, and recommendations
        Object.entries(checks).forEach(([checkName, result]) => {
            if (result.status === 'fail') {
                errors.push(`${checkName}: ${result.message}`);
            } else if (result.status === 'warning') {
                warnings.push(`${checkName}: ${result.message}`);
            }

            if (result.details) {
                recommendations.push(`${checkName}: ${result.details}`);
            }
        });

        // Add general recommendations
        if (!env.GEMINI_PROJECT_ID) {
            recommendations.push("GEMINI_PROJECT_ID can be set explicitly or will be auto-discovered at runtime");
        }

        const isValid = errors.length === 0;

        return {
            isValid,
            timestamp: Date.now(),
            checks,
            warnings,
            errors,
            recommendations,
        };
    }

    /**
     * Create deployment validation endpoint response
     */
    public async createValidationResponse(env: Env): Promise<Response> {
        try {
            const validation = await this.validateDeployment(env);
            
            const statusCode = validation.isValid ? 200 : 
                              validation.warnings.length > 0 ? 200 : 500;

            return new Response(JSON.stringify(validation, null, 2), {
                status: statusCode,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'X-Deployment-Validation-Version': '1.0',
                },
            });
        } catch (error) {
            console.error('Deployment validation failed:', error);
            
            return new Response(JSON.stringify({
                isValid: false,
                timestamp: Date.now(),
                error: 'Deployment validation system failure',
                message: error instanceof Error ? error.message : 'Unknown error',
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                },
            });
        }
    }

    private async checkEnvironmentVariables(env: Env): Promise<DeploymentCheckStatus> {
        try {
            const requiredVars = ['GCP_SERVICE_ACCOUNT'];
            const optionalVars = ['GEMINI_PROJECT_ID'];
            const missingRequired: string[] = [];
            const missingOptional: string[] = [];

            // Check required environment variables
            requiredVars.forEach(varName => {
                if (!env[varName as keyof Env]) {
                    missingRequired.push(varName);
                }
            });

            // Check optional environment variables
            optionalVars.forEach(varName => {
                if (!env[varName as keyof Env]) {
                    missingOptional.push(varName);
                }
            });

            if (missingRequired.length > 0) {
                return {
                    status: 'fail',
                    message: `Missing required environment variables: ${missingRequired.join(', ')}`,
                    details: 'Set these variables in the Cloudflare dashboard under Worker Settings > Environment Variables',
                };
            }

            if (missingOptional.length > 0) {
                return {
                    status: 'warning',
                    message: `Missing optional environment variables: ${missingOptional.join(', ')}`,
                    details: 'These variables will be auto-discovered at runtime if not provided',
                };
            }

            // Validate GCP_SERVICE_ACCOUNT format
            try {
                const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT);
                const requiredFields = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
                const missingFields = requiredFields.filter(field => !serviceAccount[field]);
                
                if (missingFields.length > 0) {
                    return {
                        status: 'fail',
                        message: `Invalid GCP service account JSON: missing fields ${missingFields.join(', ')}`,
                        details: 'Ensure you have a valid service account JSON with all required fields',
                    };
                }
            } catch (jsonError) {
                return {
                    status: 'fail',
                    message: 'GCP_SERVICE_ACCOUNT is not valid JSON',
                    details: 'The service account must be a valid JSON string',
                };
            }

            return {
                status: 'pass',
                message: 'All environment variables are properly configured',
            };
        } catch (error: any) {
            return {
                status: 'fail',
                message: `Environment variable check failed: ${error.message}`,
            };
        }
    }

    private async checkKVNamespace(env: Env): Promise<DeploymentCheckStatus> {
        try {
            if (!env.GEMINI_CREDS_KV) {
                return {
                    status: 'fail',
                    message: 'KV namespace GEMINI_CREDS_KV is not bound',
                    details: 'Ensure the KV namespace is properly bound in wrangler.toml',
                };
            }

            // Test KV connectivity
            const testKey = 'deployment-validation-test';
            const testValue = Date.now().toString();
            
            await env.GEMINI_CREDS_KV.put(testKey, testValue, { expirationTtl: 60 });
            const retrieved = await env.GEMINI_CREDS_KV.get(testKey);
            
            if (retrieved !== testValue) {
                return {
                    status: 'fail',
                    message: 'KV namespace read/write test failed',
                    details: 'The KV namespace is bound but not functioning correctly',
                };
            }

            // Clean up test data
            await env.GEMINI_CREDS_KV.delete(testKey);

            return {
                status: 'pass',
                message: 'KV namespace is properly configured and functional',
            };
        } catch (error: any) {
            return {
                status: 'fail',
                message: `KV namespace check failed: ${error.message}`,
                details: 'Verify that the KV namespace exists and is properly bound',
            };
        }
    }

    private async checkAuthenticationFlow(env: Env): Promise<DeploymentCheckStatus> {
        try {
            const authManager = AuthManager.getInstance(env);
            await authManager.initialize();
            
            // Try to get access token
            const token = await authManager.getAccessToken();
            
            if (!token || token.length < 10) {
                return {
                    status: 'fail',
                    message: 'Authentication flow failed to generate valid token',
                    details: 'Check that the GCP service account has the necessary permissions for Code Assist API',
                };
            }

            // Validate token format (should be a JWT or similar)
            if (!token.includes('.') && !token.startsWith('ya29.')) {
                return {
                    status: 'warning',
                    message: 'Generated token format appears unusual',
                    details: 'Token was generated but may not be in expected format',
                };
            }

            return {
                status: 'pass',
                message: 'Authentication flow is working correctly',
            };
        } catch (error: any) {
            return {
                status: 'fail',
                message: `Authentication flow failed: ${error.message}`,
                details: 'Verify GCP service account credentials and permissions',
            };
        }
    }

    private async checkProjectDiscovery(env: Env): Promise<DeploymentCheckStatus> {
        try {
            const authManager = AuthManager.getInstance(env);
            await authManager.initialize();
            
            const projectId = await ProjectCacheManager.getProjectId(authManager, env, 'deployment-validation');
            
            if (!projectId) {
                return {
                    status: 'fail',
                    message: 'Project ID discovery failed',
                    details: 'Unable to discover or retrieve project ID. Consider setting GEMINI_PROJECT_ID environment variable',
                };
            }

            // Validate project ID format
            if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(projectId)) {
                return {
                    status: 'warning',
                    message: 'Discovered project ID format appears unusual',
                    details: `Project ID: ${projectId}. Verify this is correct for your GCP project`,
                };
            }

            return {
                status: 'pass',
                message: `Project ID successfully discovered: ${projectId}`,
            };
        } catch (error: any) {
            return {
                status: 'fail',
                message: `Project discovery failed: ${error.message}`,
                details: 'Set GEMINI_PROJECT_ID environment variable or ensure service account has project access',
            };
        }
    }

    private async checkConfiguration(env: Env): Promise<DeploymentCheckStatus> {
        try {
            const warnings: string[] = [];
            const recommendations: string[] = [];

            // Check performance optimization flags
            const performanceFlags = [
                'ENABLE_CONNECTION_POOLING',
                'TOKEN_REFRESH_BUFFER_MINUTES',
                'MAX_CONCURRENT_REQUESTS',
                'CACHE_PROJECT_ID_TTL_HOURS',
                'CIRCUIT_BREAKER_THRESHOLD',
                'CIRCUIT_BREAKER_TIMEOUT_MS'
            ];

            performanceFlags.forEach(flag => {
                if (!env[flag as keyof Env]) {
                    warnings.push(`Performance flag ${flag} not set, using default`);
                }
            });

            // Validate numeric configuration values
            const numericConfigs = {
                TOKEN_REFRESH_BUFFER_MINUTES: { min: 1, max: 30, default: 5 },
                MAX_CONCURRENT_REQUESTS: { min: 10, max: 1000, default: 100 },
                CACHE_PROJECT_ID_TTL_HOURS: { min: 0.5, max: 24, default: 1 },
                CIRCUIT_BREAKER_THRESHOLD: { min: 1, max: 20, default: 5 },
                CIRCUIT_BREAKER_TIMEOUT_MS: { min: 5000, max: 120000, default: 30000 }
            };

            Object.entries(numericConfigs).forEach(([key, config]) => {
                const value = env[key as keyof Env];
                if (value) {
                    const numValue = parseInt(value as string);
                    if (isNaN(numValue) || numValue < config.min || numValue > config.max) {
                        warnings.push(`${key} value ${value} is outside recommended range ${config.min}-${config.max}`);
                    }
                }
            });

            if (warnings.length > 0) {
                recommendations.push('Review configuration values for optimal performance');
            }

            const status = warnings.length > 5 ? 'warning' : 'pass';
            const message = status === 'pass' ? 
                'Configuration is properly set up' : 
                `Configuration has ${warnings.length} warnings`;

            return {
                status,
                message,
                details: warnings.length > 0 ? warnings.slice(0, 3).join('; ') : undefined,
            };
        } catch (error: any) {
            return {
                status: 'fail',
                message: `Configuration check failed: ${error.message}`,
            };
        }
    }

    /**
     * Quick validation check for startup
     */
    public async quickValidation(env: Env): Promise<boolean> {
        try {
            // Check only critical requirements
            if (!env.GCP_SERVICE_ACCOUNT) return false;
            if (!env.GEMINI_CREDS_KV) return false;
            
            // Test KV connectivity
            const testKey = 'quick-validation-test';
            await env.GEMINI_CREDS_KV.put(testKey, 'test', { expirationTtl: 30 });
            await env.GEMINI_CREDS_KV.delete(testKey);
            
            return true;
        } catch (error) {
            console.error('Quick validation failed:', error);
            return false;
        }
    }

    /**
     * Perform startup validation with detailed logging
     * This is called when the worker starts to ensure all resources are available
     */
    public async performStartupValidation(env: Env): Promise<{
        success: boolean;
        criticalErrors: string[];
        warnings: string[];
        recommendations: string[];
    }> {
        console.log('🚀 Starting deployment validation...');
        
        const criticalErrors: string[] = [];
        const warnings: string[] = [];
        const recommendations: string[] = [];

        try {
            // Perform comprehensive validation
            const validation = await this.validateDeployment(env);
            
            // Extract critical errors (failures that prevent operation)
            validation.errors.forEach(error => {
                if (error.includes('environment:') || error.includes('kvNamespace:') || error.includes('authentication:')) {
                    criticalErrors.push(error);
                } else {
                    warnings.push(error);
                }
            });

            // Add all warnings from validation
            warnings.push(...validation.warnings);
            recommendations.push(...validation.recommendations);

            // Log validation results
            if (criticalErrors.length === 0) {
                console.log('✅ Startup validation passed');
                if (warnings.length > 0) {
                    console.warn(`⚠️  ${warnings.length} warnings detected:`);
                    warnings.forEach(warning => console.warn(`   - ${warning}`));
                }
                if (recommendations.length > 0) {
                    console.log(`💡 ${recommendations.length} recommendations:`);
                    recommendations.forEach(rec => console.log(`   - ${rec}`));
                }
            } else {
                console.error('❌ Startup validation failed with critical errors:');
                criticalErrors.forEach(error => console.error(`   - ${error}`));
            }

            return {
                success: criticalErrors.length === 0,
                criticalErrors,
                warnings,
                recommendations
            };
        } catch (error) {
            const errorMessage = `Startup validation system failure: ${error instanceof Error ? error.message : 'Unknown error'}`;
            console.error('❌ ' + errorMessage);
            criticalErrors.push(errorMessage);
            
            return {
                success: false,
                criticalErrors,
                warnings,
                recommendations
            };
        }
    }

    /**
     * Validate deployment bindings and configuration
     * Specifically checks requirements 3.3, 3.4, 3.5
     */
    public async validateDeploymentBindings(env: Env): Promise<DeploymentCheckStatus> {
        try {
            const issues: string[] = [];
            const successes: string[] = [];

            // Check KV namespace binding (Requirement 3.3)
            if (!env.GEMINI_CREDS_KV) {
                issues.push('KV namespace GEMINI_CREDS_KV is not bound - deployment incomplete');
            } else {
                try {
                    // Test KV binding functionality
                    const testKey = 'binding-validation-test';
                    const testValue = Date.now().toString();
                    await env.GEMINI_CREDS_KV.put(testKey, testValue, { expirationTtl: 60 });
                    const retrieved = await env.GEMINI_CREDS_KV.get(testKey);
                    await env.GEMINI_CREDS_KV.delete(testKey);
                    
                    if (retrieved === testValue) {
                        successes.push('KV namespace binding is functional');
                    } else {
                        issues.push('KV namespace binding exists but is not functional');
                    }
                } catch (kvError) {
                    issues.push(`KV namespace binding test failed: ${kvError instanceof Error ? kvError.message : 'Unknown error'}`);
                }
            }

            // Check environment variable security (Requirement 3.4)
            if (!env.GCP_SERVICE_ACCOUNT) {
                issues.push('GCP_SERVICE_ACCOUNT environment variable not set - secrets not properly configured');
            } else {
                try {
                    const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT);
                    if (serviceAccount.private_key && serviceAccount.client_email) {
                        successes.push('GCP service account secrets are properly configured');
                    } else {
                        issues.push('GCP service account JSON is missing required fields');
                    }
                } catch (jsonError) {
                    issues.push('GCP_SERVICE_ACCOUNT is not valid JSON');
                }
            }

            // Check project ID configuration (Requirement 3.5)
            if (!env.GEMINI_PROJECT_ID) {
                successes.push('GEMINI_PROJECT_ID not provided - will be discovered at runtime (as designed)');
                
                // Test project ID discovery capability
                try {
                    const authManager = AuthManager.getInstance(env);
                    await authManager.initialize();
                    const projectId = await ProjectCacheManager.getProjectId(authManager, env, 'binding-validation');
                    
                    if (projectId) {
                        successes.push(`Project ID discovery successful: ${projectId}`);
                    } else {
                        issues.push('Project ID discovery failed - consider setting GEMINI_PROJECT_ID manually');
                    }
                } catch (discoveryError) {
                    issues.push(`Project ID discovery test failed: ${discoveryError instanceof Error ? discoveryError.message : 'Unknown error'}`);
                }
            } else {
                successes.push(`GEMINI_PROJECT_ID explicitly configured: ${env.GEMINI_PROJECT_ID}`);
            }

            // Determine overall status
            if (issues.length === 0) {
                return {
                    status: 'pass',
                    message: `All deployment bindings validated successfully. ${successes.join('; ')}`,
                    details: 'Deployment meets requirements 3.3, 3.4, and 3.5'
                };
            } else if (issues.length === 1 && issues[0].includes('Project ID discovery')) {
                return {
                    status: 'warning',
                    message: `Deployment bindings mostly functional with minor issues: ${issues.join('; ')}`,
                    details: `Successes: ${successes.join('; ')}`
                };
            } else {
                return {
                    status: 'fail',
                    message: `Deployment binding validation failed: ${issues.join('; ')}`,
                    details: successes.length > 0 ? `Partial successes: ${successes.join('; ')}` : 'No successful validations'
                };
            }
        } catch (error) {
            return {
                status: 'fail',
                message: `Deployment binding validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                details: 'Unable to validate deployment bindings'
            };
        }
    }
}