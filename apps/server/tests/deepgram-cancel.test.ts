import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture every fake socket the provider opens so tests can drive Deepgram's
// response sequence and inspect the control frames sent by the provider.
const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1; // OPEN
  binaryType = "arraybuffer";
  sent: string[] = [];
  closed = false;
  handlers = new Map<string, (...args: unknown[]) => void>();
  send = vi.fn((data: unknown) => {
    if (typeof data === "string") this.sent.push(data);
  });
  close = vi.fn(() => {
    this.closed = true;
  });
  on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler);
  });
  addEventListener = vi.fn();

  constructor() {
    sockets.push(this);
  }

  receive(message: Record<string, unknown>) {
    this.handlers.get("message")?.(JSON.stringify(message));
  }
}

vi.mock("ws", () => ({ default: FakeSocket }));

const { DeepgramTranscriptionProvider } = await import(
  "../src/lib/streaming/providers/deepgram.js"
);

function openSession() {
  const provider = new DeepgramTranscriptionProvider();
  const callbacks = {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const session = provider.openStreamingSession({
    apiKey: "test-key",
    model: "nova-3",
    language: "en",
    bias: null,
    callbacks,
  });
  return { session, callbacks };
}

describe("DeepgramTranscriptionProvider", () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it("cancels without asking Deepgram to transcribe buffered audio", () => {
    const { session } = openSession();
    const socket = sockets[0];

    session.cancel();

    expect(socket.sent).not.toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
  });

  it("ends a dictation with CloseStream instead of Finalize", () => {
    const { session } = openSession();
    const socket = sockets[0];

    session.commit();

    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.sent).not.toContain(JSON.stringify({ type: "Finalize" }));
    socket.receive({ type: "Metadata" });
  });

  it("collects every final result before completing on Metadata", () => {
    const { session, callbacks } = openSession();
    const socket = sockets[0];

    socket.receive({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "First segment." }] },
    });

    session.commit();
    socket.receive({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "Second segment." }] },
    });

    expect(callbacks.onFinal).not.toHaveBeenCalled();

    socket.receive({ type: "Metadata" });

    expect(callbacks.onFinal).toHaveBeenCalledOnce();
    expect(callbacks.onFinal).toHaveBeenCalledWith(
      "First segment. Second segment.",
    );
  });

  it("completes on Metadata when the final Results message is empty", () => {
    const { session, callbacks } = openSession();
    const socket = sockets[0];

    socket.receive({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "Already finalized." }] },
    });

    session.commit();
    socket.receive({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "" }] },
    });

    expect(callbacks.onFinal).not.toHaveBeenCalled();

    socket.receive({ type: "Metadata" });

    expect(callbacks.onFinal).toHaveBeenCalledOnce();
    expect(callbacks.onFinal).toHaveBeenCalledWith("Already finalized.");
  });

  it("close() tears the socket down", () => {
    const { session } = openSession();
    const socket = sockets[0];

    session.close();

    expect(socket.close).toHaveBeenCalled();
  });
});
