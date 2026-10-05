import { PluginRegistry } from "freestyle-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The streaming route resolves one context snapshot per recording, before the
// upstream session opens. Audio keeps buffering meanwhile, the resolved bias
// joins the session-reuse fingerprint, and a slow collector never blocks
// dictation.

type Events = {
  onOpen: (event: unknown, ws: FakeWs) => void;
  onMessage: (event: { data: unknown }, ws: FakeWs) => void;
};
type FakeWs = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
type FakeSession = {
  sendAudio: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  waitUntilReady: () => Promise<void>;
};

const harness = vi.hoisted(() => ({
  createEvents: undefined as undefined | (() => unknown),
}));

vi.mock("@hono/node-server", () => ({
  upgradeWebSocket: (createEvents: () => unknown) => {
    harness.createEvents = createEvents;
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));

const openStreamingSession = vi.fn((_opts: { bias?: unknown }): FakeSession => {
  return {
    sendAudio: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    reset: vi.fn(),
    waitUntilReady: () => Promise.resolve(),
  };
});

vi.mock("../src/lib/streaming-stt.js", () => ({
  getApiKeyForProvider: () => "test-key",
  openStreamingSession,
  supportsSessionTransport: () => true,
  supportsStreaming: () => true,
  voiceProviderCategory: () => "byok",
}));

vi.mock("../src/lib/providers.js", () => ({
  getDefaultModels: () => ({
    voice: { provider: "deepgram", model_id: "deepgram/nova-3" },
    llm: null,
  }),
}));

const registry = { current: new PluginRegistry() };
vi.mock("../src/lib/plugins/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/plugins/index.js")>();
  return { ...actual, plugins: () => registry.current };
});

await import("../src/routes/stream.js");

function collector(symbol: string) {
  return new PluginRegistry([
    {
      name: "collector",
      resolveRecognitionContext: (_input, output) => {
        output.snapshot = { capturedAt: 1, editor: { symbols: [symbol] } };
      },
    },
  ]);
}

function connect(): { events: Events; ws: FakeWs } {
  const events = harness.createEvents?.() as Events;
  return { events, ws: { send: vi.fn(), close: vi.fn() } };
}

const start = (events: Events, ws: FakeWs) =>
  events.onMessage({ data: JSON.stringify({ type: "start" }) }, ws);

async function settle(ms = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function sentTypes(ws: FakeWs): string[] {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(payload).type);
}

describe("stream route recognition context", () => {
  beforeEach(() => {
    openStreamingSession.mockClear();
    registry.current = new PluginRegistry();
  });

  it("biases the session with context and flushes audio buffered meanwhile", async () => {
    registry.current = collector("resolveRecognitionContext");
    const { events, ws } = connect();

    start(events, ws);
    const chunk = new ArrayBuffer(8);
    events.onMessage({ data: chunk }, ws);
    await settle();

    expect(openStreamingSession).toHaveBeenCalledTimes(1);
    expect(openStreamingSession.mock.calls[0]?.[0].bias).toEqual({
      kind: "deepgram-keyterms",
      terms: ["resolveRecognitionContext"],
    });
    const session = openStreamingSession.mock.results[0]?.value as FakeSession;
    expect(session.sendAudio).toHaveBeenCalledWith(chunk);
    expect(sentTypes(ws)).toContain("session.ready");
  });

  it("reuses a warm session only while the context bias is unchanged", async () => {
    const { events, ws } = connect();
    events.onOpen({}, ws);
    expect(openStreamingSession).toHaveBeenCalledTimes(1);

    registry.current = collector("firstSymbol");
    start(events, ws);
    await settle();
    // Warm session was built without context: a fresh one is required.
    expect(openStreamingSession).toHaveBeenCalledTimes(2);
    const warm = openStreamingSession.mock.results[0]?.value as FakeSession;
    expect(warm.close).toHaveBeenCalled();

    start(events, ws);
    await settle();
    const current = openStreamingSession.mock.results[1]?.value as FakeSession;
    expect(openStreamingSession).toHaveBeenCalledTimes(2);
    expect(current.reset).toHaveBeenCalledTimes(1);

    registry.current = collector("secondSymbol");
    start(events, ws);
    await settle();
    expect(openStreamingSession).toHaveBeenCalledTimes(3);
    expect(current.close).toHaveBeenCalled();
  });

  it("opens the session without context when a collector stalls", async () => {
    registry.current = new PluginRegistry([
      {
        name: "stalled-collector",
        resolveRecognitionContext: () => new Promise<void>(() => {}),
      },
    ]);
    const { events, ws } = connect();

    start(events, ws);
    await settle(249);
    expect(openStreamingSession).not.toHaveBeenCalled();

    await settle(1);
    expect(openStreamingSession).toHaveBeenCalledTimes(1);
    expect(openStreamingSession.mock.calls[0]?.[0].bias).toBeNull();
  });

  it("opens no session when the recording is cancelled while context resolves", async () => {
    registry.current = collector("resolveRecognitionContext");
    const { events, ws } = connect();

    start(events, ws);
    events.onMessage({ data: JSON.stringify({ type: "cancel" }) }, ws);
    await settle();

    expect(openStreamingSession).not.toHaveBeenCalled();
  });
});
