import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

describe("typed API client startup routing", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      api: {
        getServerUrl: vi.fn(async () => "https://desktop.example.test"),
        getServerToken: vi.fn(async () => "configured-server-token"),
        getServerPort: vi.fn(async () => 4649),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the configured target and bearer token at request dispatch", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { getClient } = await import("./api");

    await getClient().api.settings.$get();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://desktop.example.test/api/settings");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer configured-server-token",
    );
  });

  it("preserves the JSON device-token poll body while routing to the configured target", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { getClient } = await import("./api");

    await getClient().api.auth.device.token.$post({
      json: { device_code: "device-code" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://desktop.example.test/api/auth/device/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer configured-server-token",
    );
    // A stream body fails in Electron's Chromium over HTTP/1.1.
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(
      JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)),
    ).toEqual({ device_code: "device-code" });
  });

  it("reports a typed protected 401 to the shared observer", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { getClient, subscribeToUnauthorized } = await import("./api");
    const unauthorized = vi.fn();
    const unsubscribe = subscribeToUnauthorized(unauthorized);

    await getClient().api.settings.$get();

    expect(unauthorized).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not sign out for a stale Remix ownership response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "remix_account_changed" }, { status: 401 }),
    );
    const { getClient, subscribeToUnauthorized } = await import("./api");
    const unauthorized = vi.fn();
    const unsubscribe = subscribeToUnauthorized(unauthorized);

    await getClient().api.settings.$get();

    expect(unauthorized).not.toHaveBeenCalled();
    unsubscribe();
  });
});
