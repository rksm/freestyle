import { beforeEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  private handlers = new Map<string, (...args: unknown[]) => void>();

  send = vi.fn((data: unknown) => {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  });
  close = vi.fn();
  on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler);
  });

  constructor(
    readonly url: string,
    readonly options: { headers: Record<string, string> },
  ) {
    sockets.push(this);
  }

  get params(): URLSearchParams {
    return new URL(this.url).searchParams;
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.handlers.get("open")?.();
  }
  reply(payload: unknown): void {
    this.handlers.get("message")?.(Buffer.from(JSON.stringify(payload)));
  }
  closeFromServer(code: number, reason = ""): void {
    this.readyState = FakeSocket.CLOSED;
    this.handlers.get("close")?.(code, Buffer.from(reason));
  }
}

vi.mock("ws", () => ({ default: FakeSocket }));

const { AssemblyAITranscriptionProvider } = await import(
  "../src/lib/streaming/providers/assemblyai.js"
);

const provider = new AssemblyAITranscriptionProvider();

function openSession(
  model: string,
  extra: {
    languages?: string[];
    bias?: { kind: string; terms: string[] };
  } = {},
) {
  const callbacks = {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const session = provider.openStreamingSession({
    apiKey: "key",
    model,
    languages: extra.languages,
    bias: extra.bias as never,
    callbacks,
  });
  return { session, socket: sockets.at(-1)!, callbacks };
}

const turn = (turn_order: number, transcript: string, end_of_turn = false) => ({
  type: "Turn",
  turn_order,
  transcript,
  end_of_turn,
  turn_is_formatted: true,
});

describe("AssemblyAI streaming", () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it("connects with the model, keyterms, and supported languages", () => {
    const { socket } = openSession("assemblyai/universal-3-6-pro", {
      languages: ["de", "pl", "en"],
      bias: { kind: "assemblyai-keyterms", terms: ["NixOS", "WezTerm"] },
    });

    expect(socket.options.headers.Authorization).toBe("key");
    expect(socket.params.get("speech_model")).toBe("universal-3-6-pro");
    expect(socket.params.get("sample_rate")).toBe("16000");
    expect(socket.params.get("language_codes")).toBe('["de","en"]');
    expect(socket.params.get("keyterms_prompt")).toBe('["NixOS","WezTerm"]');
    expect(socket.params.has("format_turns")).toBe(false);
  });

  it("asks Universal-Streaming for formatted turns and sends no languages", () => {
    const { socket } = openSession("assemblyai/universal-streaming-english", {
      languages: ["de"],
    });

    expect(socket.params.get("format_turns")).toBe("true");
    expect(socket.params.has("language_codes")).toBe(false);
    expect(socket.params.has("keyterms_prompt")).toBe(false);
  });

  it("holds audio until open, then terminates a commit made meanwhile", () => {
    const { session, socket } = openSession("assemblyai/universal-3-6-pro");
    const chunk = new Uint8Array([1, 2]).buffer;

    session.sendAudio(chunk);
    session.commit();
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toEqual([chunk, { type: "Terminate" }]);
  });

  it("previews finished turns plus the current partial", () => {
    const { session, socket, callbacks } = openSession(
      "assemblyai/universal-3-6-pro",
    );
    socket.open();
    session.sendAudio(new ArrayBuffer(2));

    socket.reply(turn(0, "First turn.", true));
    socket.reply(turn(1, "second"));
    socket.reply(turn(1, ""));

    expect(callbacks.onPartial).toHaveBeenLastCalledWith("First turn. second");
  });

  it("delivers the whole transcript once, on Termination", () => {
    const { session, socket, callbacks } = openSession(
      "assemblyai/universal-streaming-english",
    );
    socket.open();
    socket.reply(turn(0, "First turn.", true));
    socket.reply(turn(1, "second"));

    session.commit();
    expect(socket.sent).toEqual([{ type: "Terminate" }]);

    socket.reply(turn(1, "Second turn.", true));
    socket.reply(turn(2, "", true)); // closing turn for an unfinished one
    expect(callbacks.onFinal).not.toHaveBeenCalled();

    socket.reply({ type: "Termination", audio_duration_seconds: 3 });
    socket.closeFromServer(1000, "Session Ended");
    expect(callbacks.onFinal).toHaveBeenCalledTimes(1);
    expect(callbacks.onFinal).toHaveBeenCalledWith("First turn. Second turn.");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("delivers what it has when Termination never arrives", () => {
    const { session, socket, callbacks } = openSession(
      "assemblyai/universal-3-6-pro",
    );
    socket.open();
    socket.reply(turn(0, "Partial words"));

    session.commit();
    vi.advanceTimersByTime(4_999);
    expect(callbacks.onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callbacks.onFinal).toHaveBeenCalledWith("Partial words");
  });

  it("settles a committed dictation when the server drops the session", () => {
    const { session, socket, callbacks } = openSession(
      "assemblyai/universal-3-6-pro",
    );
    socket.open();
    socket.reply(turn(0, "Partial words"));

    session.commit();
    socket.closeFromServer(3005, "Session Cancelled");
    expect(callbacks.onFinal).toHaveBeenCalledWith("Partial words");
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("reports the Error message when the server closes the session", () => {
    const { socket, callbacks } = openSession("assemblyai/universal-3-6-pro");
    socket.open();

    socket.reply({ type: "Error", error_code: 3006, error: "Invalid input" });
    socket.closeFromServer(3006, "See Error message for details");

    expect(callbacks.onError).toHaveBeenCalledWith(
      "AssemblyAI closed the session (3006): Invalid input",
    );
  });

  it("stays quiet when the route closes the session", () => {
    const { session, socket, callbacks } = openSession(
      "assemblyai/universal-3-6-pro",
    );
    socket.open();

    session.close();
    expect(socket.close).toHaveBeenCalled();
    socket.closeFromServer(1005);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onFinal).not.toHaveBeenCalled();
  });
});

describe("AssemblyAI batch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  async function sentConfig(): Promise<Record<string, unknown>> {
    const body = fetchMock.mock.calls[0]?.[1].body as FormData;
    return JSON.parse(await (body.get("config") as Blob).text());
  }

  it("posts the WAV to Sync STT with language and keyterms", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ text: " Hello NixOS. ", audio_duration_ms: 1500 }),
    );

    const result = await provider.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      model: "assemblyai/universal-3-6-pro",
      apiKey: "key",
      language: "de",
      bias: { kind: "assemblyai-keyterms", terms: ["NixOS"] },
    });

    expect(result).toEqual({ text: "Hello NixOS.", durationInSeconds: 1.5 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sync.assemblyai.com/v1/transcribe");
    expect(init.headers).toEqual({
      Authorization: "key",
      "X-AAI-Model": "universal-3-5-pro",
    });
    expect(await sentConfig()).toEqual({
      language_codes: ["de"],
      keyterms_prompt: ["NixOS"],
    });
    const audio = (init.body as FormData).get("audio") as Blob;
    expect(audio.type).toBe("audio/wav");
  });

  it("pins the English-only model to English", async () => {
    fetchMock.mockResolvedValue(Response.json({ text: "Hi" }));

    await provider.transcribe({
      audio: new Uint8Array([1]),
      model: "assemblyai/universal-streaming-english",
      apiKey: "key",
      language: "de",
    });

    expect(await sentConfig()).toEqual({ language_codes: ["en"] });
  });

  it("surfaces the API error", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error_code: "audio_too_large", message: "Audio exceeds 120 s" },
        { status: 413 },
      ),
    );

    await expect(
      provider.transcribe({
        audio: new Uint8Array([1]),
        model: "assemblyai/universal-3-6-pro",
        apiKey: "key",
      }),
    ).rejects.toThrow(
      /AssemblyAI transcription failed \(413\).*audio_too_large/,
    );
  });
});
