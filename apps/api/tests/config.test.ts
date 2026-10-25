import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/config/env.js";

describe("parseEnvironment", () => {
  it("accepts a valid PostgreSQL URL and defaults optional settings", () => {
    const config = parseEnvironment({
      DATABASE_URL: "postgresql://user:password@localhost:5432/logforge"
    });

    expect(config.PORT).toBe(3001);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("development");
    expect(config.REDIS_URL).toBe("redis://127.0.0.1:16379");
    expect(config.PROCESSING_BATCH_SIZE).toBe(500);
  });

  it("reports missing and invalid configuration by name", () => {
    expect(() => parseEnvironment({ DATABASE_URL: "not-a-url" })).toThrow(
      /Invalid environment configuration: DATABASE_URL/
    );
    expect(() => parseEnvironment({ DATABASE_URL: "https://example.test" })).toThrow(
      /must be a valid PostgreSQL connection URL/
    );
  });

  it("rejects an out-of-range port", () => {
    expect(() =>
      parseEnvironment({
        DATABASE_URL: "postgresql://user:password@localhost:5432/logforge",
        PORT: "70000"
      })
    ).toThrow(/PORT/);
  });

  it("accepts empty optional R2 values and rejects partial R2 credentials", () => {
    expect(
      parseEnvironment({
        DATABASE_URL: "postgresql://localhost:5432/logforge",
        R2_ACCOUNT_ID: "",
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
        R2_BUCKET_NAME: "",
        R2_ENDPOINT: ""
      }).R2_ACCOUNT_ID
    ).toBeUndefined();

    expect(() =>
      parseEnvironment({
        DATABASE_URL: "postgresql://localhost:5432/logforge",
        R2_ACCOUNT_ID: "account"
      })
    ).toThrow(/must be configured together/);
  });

  it("accepts a custom HTTPS endpoint when all R2 credentials are present", () => {
    expect(
      parseEnvironment({
        DATABASE_URL: "postgresql://localhost:5432/logforge",
        R2_ACCOUNT_ID: "account",
        R2_ACCESS_KEY_ID: "access",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET_NAME: "bucket",
        R2_ENDPOINT: "https://r2.example.test"
      }).R2_ENDPOINT
      ).toBe("https://r2.example.test");
  });

  it("keeps the upload limit within the documented 10–100 MB range", () => {
    expect(() =>
      parseEnvironment({
        DATABASE_URL: "postgresql://localhost:5432/logforge",
        MAX_UPLOAD_SIZE_BYTES: "100000001"
      })
    ).toThrow(/MAX_UPLOAD_SIZE_BYTES/);
  });

  it("caps presigned URLs at 15 minutes", () => {
    expect(() =>
      parseEnvironment({
        DATABASE_URL: "postgresql://localhost:5432/logforge",
        R2_PRESIGNED_URL_TTL_SECONDS: "901"
      })
    ).toThrow(/R2_PRESIGNED_URL_TTL_SECONDS/);
  });
});
