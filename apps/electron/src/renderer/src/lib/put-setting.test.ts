import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.fn();

vi.mock("./api", () => ({
  getClient: () => ({ api: { settings: { ":key": { $put: put } } } }),
  resolveApiBase: vi.fn(),
}));

const { putSetting, queryKeys } = await import("./query");

describe("putSetting", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    put.mockReset();
    queryClient = new QueryClient();
  });

  it("saves the value and mirrors it into the settings cache", async () => {
    put.mockResolvedValue({ ok: true, status: 200 });
    queryClient.setQueryData(queryKeys.settings, { a: "1" });

    await putSetting(queryClient, "b", "2");

    expect(put).toHaveBeenCalledWith({
      param: { key: "b" },
      json: { value: "2" },
    });
    expect(queryClient.getQueryData(queryKeys.settings)).toEqual({
      a: "1",
      b: "2",
    });
  });

  it("leaves an unloaded cache alone", async () => {
    put.mockResolvedValue({ ok: true, status: 200 });

    await putSetting(queryClient, "b", "2");

    expect(queryClient.getQueryData(queryKeys.settings)).toBeUndefined();
  });

  it("throws and keeps the cache unchanged when the server rejects", async () => {
    put.mockResolvedValue({ ok: false, status: 400 });
    queryClient.setQueryData(queryKeys.settings, { a: "1" });

    await expect(putSetting(queryClient, "b", "2")).rejects.toThrow(
      'Failed to save setting "b" (400)',
    );
    expect(queryClient.getQueryData(queryKeys.settings)).toEqual({ a: "1" });
  });
});
