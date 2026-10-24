import { describe, it, expect, vi } from "vitest";
import { SignJWT } from "jose";

// SECRET is read once at module load, so the env must be set before import.
const SHARED_SECRET = "shared-secret-for-test";
process.env.JWT_SECRET = SHARED_SECRET;

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: "/nonexistent" }));

const {
  createDashboardAuthToken,
  verifyDashboardAuthToken,
  getDashboardAuthSession,
} = await import("../../src/lib/auth/dashboardSession.js");

const signWithSharedSecret = (claims) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(SHARED_SECRET));

describe("dashboard session claims", () => {
  it("accepts a token minted by createDashboardAuthToken", async () => {
    const token = await createDashboardAuthToken({ oidc: true, oidcSub: "1" });

    expect(await verifyDashboardAuthToken(token)).toBe(true);
    expect((await getDashboardAuthSession(token))?.oidcSub).toBe("1");
  });

  it("rejects a foreign HS256 token signed with the same secret", async () => {
    // Shape of an ai-gateway access token when both services read one JWT_SECRET.
    const foreign = await signWithSharedSecret({ sub: "2", role: "user", type: "access" });

    expect(await verifyDashboardAuthToken(foreign)).toBe(false);
    expect(await getDashboardAuthSession(foreign)).toBeNull();
  });

  it("rejects a token whose authenticated claim is not literally true", async () => {
    const truthy = await signWithSharedSecret({ authenticated: "yes" });

    expect(await verifyDashboardAuthToken(truthy)).toBe(false);
  });

  it("rejects a missing or garbage token", async () => {
    expect(await verifyDashboardAuthToken("")).toBe(false);
    expect(await verifyDashboardAuthToken("not.a.jwt")).toBe(false);
    expect(await getDashboardAuthSession(undefined)).toBeNull();
  });
});
