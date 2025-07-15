import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeploymentValidator } from "../src/deployment-validator";
import { Env } from "../src/types";

// Test-specific type that allows for missing required properties
type TestEnv = Partial<Env> & {
  GEMINI_CREDS_KV?: any;
};

// Mock the dependencies
vi.mock("../src/auth", () => ({
  AuthManager: {
    getInstance: vi.fn(() => ({
      initialize: vi.fn(),
      getAccessToken: vi.fn(() => Promise.resolve("ya29.mock-token-12345")),
    })),
  },
}));

vi.mock("../src/project-cache", () => ({
  ProjectCacheManager: {
    getProjectId: vi.fn(() => Promise.resolve("test-project-123")),
  },
}));

describe("DeploymentValidator", () => {
  let validator: DeploymentValidator;
  let mockEnv: Env;

  beforeEach(() => {
    validator = DeploymentValidator.getInstance();

    mockEnv = {
      GCP_SERVICE_ACCOUNT: JSON.stringify({
        type: "service_account",
        project_id: "test-project",
        private_key_id: "key-id",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----\n",
        client_email: "test@test-project.iam.gserviceaccount.com",
        client_id: "123456789",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
      GEMINI_PROJECT_ID: "test-project-123",
      GEMINI_CREDS_KV: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as any,
      ENABLE_CONNECTION_POOLING: "true",
      TOKEN_REFRESH_BUFFER_MINUTES: "5",
      MAX_CONCURRENT_REQUESTS: "100",
    } as Env;
  });

  describe("validateDeployment", () => {
    it("should pass validation with complete configuration", async () => {
      // Mock successful KV operations
      let storedValue: string | null = null;
      mockEnv.GEMINI_CREDS_KV.put = vi.fn().mockImplementation((key, value) => {
        if (key.includes("deployment-validation-test")) {
          storedValue = value;
        }
        return Promise.resolve(undefined);
      });
      mockEnv.GEMINI_CREDS_KV.get = vi.fn().mockImplementation((key) => {
        if (key.includes("deployment-validation-test")) {
          return Promise.resolve(storedValue);
        }
        return Promise.resolve(null);
      });
      mockEnv.GEMINI_CREDS_KV.delete = vi.fn().mockResolvedValue(undefined);

      const result = await validator.validateDeployment(mockEnv);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.checks.environment.status).toBe("pass");
      expect(result.checks.kvNamespace.status).toBe("pass");
      expect(result.checks.authentication.status).toBe("pass");
      expect(result.checks.projectDiscovery.status).toBe("pass");
      expect(result.checks.configuration.status).toBe("pass");
    });

    it("should fail validation with missing required environment variables", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GCP_SERVICE_ACCOUNT;

      const result = await validator.validateDeployment(invalidEnv as Env);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.checks.environment.status).toBe("fail");
      expect(result.checks.environment.message).toContain(
        "Missing required environment variables"
      );
    });

    it("should fail validation with invalid JSON in GCP_SERVICE_ACCOUNT", async () => {
      const invalidEnv = { ...mockEnv };
      invalidEnv.GCP_SERVICE_ACCOUNT = "invalid-json";

      const result = await validator.validateDeployment(invalidEnv);

      expect(result.isValid).toBe(false);
      expect(result.checks.environment.status).toBe("fail");
      expect(result.checks.environment.message).toContain("not valid JSON");
    });

    it("should fail validation with missing KV namespace", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GEMINI_CREDS_KV;

      const result = await validator.validateDeployment(invalidEnv as Env);

      expect(result.isValid).toBe(false);
      expect(result.checks.kvNamespace.status).toBe("fail");
      expect(result.checks.kvNamespace.message).toContain("not bound");
    });

    it("should show warnings for missing optional environment variables", async () => {
      const envWithoutOptional = { ...mockEnv };
      delete envWithoutOptional.GEMINI_PROJECT_ID;

      // Mock successful KV operations
      let storedValue: string | null = null;
      envWithoutOptional.GEMINI_CREDS_KV.put = vi
        .fn()
        .mockImplementation((key, value) => {
          if (key.includes("deployment-validation-test")) {
            storedValue = value;
          }
          return Promise.resolve(undefined);
        });
      envWithoutOptional.GEMINI_CREDS_KV.get = vi
        .fn()
        .mockImplementation((key) => {
          if (key.includes("deployment-validation-test")) {
            return Promise.resolve(storedValue);
          }
          return Promise.resolve(null);
        });
      envWithoutOptional.GEMINI_CREDS_KV.delete = vi
        .fn()
        .mockResolvedValue(undefined);

      const result = await validator.validateDeployment(envWithoutOptional);

      expect(result.isValid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.checks.environment.status).toBe("warning");
    });
  });

  describe("quickValidation", () => {
    it("should pass quick validation with minimal requirements", async () => {
      mockEnv.GEMINI_CREDS_KV.put = vi.fn().mockResolvedValue(undefined);
      mockEnv.GEMINI_CREDS_KV.delete = vi.fn().mockResolvedValue(undefined);

      const result = await validator.quickValidation(mockEnv);

      expect(result).toBe(true);
    });

    it("should fail quick validation without required environment variables", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GCP_SERVICE_ACCOUNT;

      const result = await validator.quickValidation(invalidEnv as Env);

      expect(result).toBe(false);
    });

    it("should fail quick validation without KV namespace", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GEMINI_CREDS_KV;

      const result = await validator.quickValidation(invalidEnv as Env);

      expect(result).toBe(false);
    });
  });

  describe("createValidationResponse", () => {
    it("should create successful validation response", async () => {
      // Mock successful KV operations
      let storedValue: string | null = null;
      mockEnv.GEMINI_CREDS_KV.put = vi.fn().mockImplementation((key, value) => {
        if (key.includes("deployment-validation-test")) {
          storedValue = value;
        }
        return Promise.resolve(undefined);
      });
      mockEnv.GEMINI_CREDS_KV.get = vi.fn().mockImplementation((key) => {
        if (key.includes("deployment-validation-test")) {
          return Promise.resolve(storedValue);
        }
        return Promise.resolve(null);
      });
      mockEnv.GEMINI_CREDS_KV.delete = vi.fn().mockResolvedValue(undefined);

      const response = await validator.createValidationResponse(mockEnv);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = await response.json();
      expect(body.isValid).toBe(true);
      expect(body.timestamp).toBeDefined();
      expect(body.checks).toBeDefined();
    });

    it("should create error response for validation failure", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GCP_SERVICE_ACCOUNT;

      const response = await validator.createValidationResponse(
        invalidEnv as Env
      );

      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.isValid).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
    });
  });

  describe("performStartupValidation", () => {
    it("should perform successful startup validation", async () => {
      // Mock successful KV operations
      let storedValue: string | null = null;
      mockEnv.GEMINI_CREDS_KV.put = vi.fn().mockImplementation((key, value) => {
        if (key.includes("deployment-validation-test")) {
          storedValue = value;
        }
        return Promise.resolve(undefined);
      });
      mockEnv.GEMINI_CREDS_KV.get = vi.fn().mockImplementation((key) => {
        if (key.includes("deployment-validation-test")) {
          return Promise.resolve(storedValue);
        }
        return Promise.resolve(null);
      });
      mockEnv.GEMINI_CREDS_KV.delete = vi.fn().mockResolvedValue(undefined);

      const result = await validator.performStartupValidation(mockEnv);

      expect(result.success).toBe(true);
      expect(result.criticalErrors).toHaveLength(0);
    });

    it("should detect critical errors during startup validation", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GCP_SERVICE_ACCOUNT;

      const result = await validator.performStartupValidation(
        invalidEnv as Env
      );

      expect(result.success).toBe(false);
      expect(result.criticalErrors.length).toBeGreaterThan(0);
      expect(
        result.criticalErrors.some((error) => error.includes("environment:"))
      ).toBe(true);
    });

    it("should handle startup validation system failures", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GEMINI_CREDS_KV;

      const result = await validator.performStartupValidation(
        invalidEnv as Env
      );

      expect(result.success).toBe(false);
      expect(result.criticalErrors.length).toBeGreaterThan(0);
    });
  });

  describe("validateDeploymentBindings", () => {
    it("should validate successful deployment bindings", async () => {
      // Mock successful KV operations
      let storedValue: string | null = null;
      mockEnv.GEMINI_CREDS_KV.put = vi.fn().mockImplementation((key, value) => {
        if (key.includes("binding-validation-test")) {
          storedValue = value;
        }
        return Promise.resolve(undefined);
      });
      mockEnv.GEMINI_CREDS_KV.get = vi.fn().mockImplementation((key) => {
        if (key.includes("binding-validation-test")) {
          return Promise.resolve(storedValue);
        }
        return Promise.resolve(null);
      });
      mockEnv.GEMINI_CREDS_KV.delete = vi.fn().mockResolvedValue(undefined);

      const result = await validator.validateDeploymentBindings(mockEnv);

      expect(result.status).toBe("pass");
      expect(result.message).toContain("successfully");
    });

    it("should detect missing KV namespace binding", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GEMINI_CREDS_KV;

      const result = await validator.validateDeploymentBindings(
        invalidEnv as Env
      );

      expect(result.status).toBe("fail");
      expect(result.message).toContain("KV namespace");
    });

    it("should detect missing service account configuration", async () => {
      const invalidEnv: TestEnv = { ...mockEnv };
      delete invalidEnv.GCP_SERVICE_ACCOUNT;

      const result = await validator.validateDeploymentBindings(
        invalidEnv as Env
      );

      expect(result.status).toBe("fail");
      expect(result.message).toContain("GCP_SERVICE_ACCOUNT");
    });

    it("should handle project ID discovery when not explicitly set", async () => {
      const envWithoutProjectId = { ...mockEnv };
      delete envWithoutProjectId.GEMINI_PROJECT_ID;

      // Mock successful KV operations
      let storedValue: string | null = null;
      envWithoutProjectId.GEMINI_CREDS_KV.put = vi
        .fn()
        .mockImplementation((key, value) => {
          if (key.includes("binding-validation-test")) {
            storedValue = value;
          }
          return Promise.resolve(undefined);
        });
      envWithoutProjectId.GEMINI_CREDS_KV.get = vi
        .fn()
        .mockImplementation((key) => {
          if (key.includes("binding-validation-test")) {
            return Promise.resolve(storedValue);
          }
          return Promise.resolve(null);
        });
      envWithoutProjectId.GEMINI_CREDS_KV.delete = vi
        .fn()
        .mockResolvedValue(undefined);

      const result = await validator.validateDeploymentBindings(
        envWithoutProjectId
      );

      expect(result.status).toBe("pass");
      expect(result.message).toContain("runtime");
    });
  });

  describe("singleton pattern", () => {
    it("should return the same instance", () => {
      const instance1 = DeploymentValidator.getInstance();
      const instance2 = DeploymentValidator.getInstance();

      expect(instance1).toBe(instance2);
    });
  });
});
