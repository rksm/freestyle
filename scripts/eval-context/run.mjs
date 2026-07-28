import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_FILE = path.join(SCRIPT_DIR, "corpus.json");
const RECORDINGS_DIR = path.join(SCRIPT_DIR, "recordings");
const RESULTS_DIR = path.join(SCRIPT_DIR, "results");
const PCM_HEADER_BYTES = 44;
const PCM_CHUNK_BYTES = 2_560;
const STREAM_TIMEOUT_MS = 120_000;
const SETTINGS_KEYS = [
  "context_enabled",
  "context_to_asr",
  "context_to_cleanup",
];

const CONFIGS = {
  baseline: {
    context_enabled: "false",
    context_to_asr: "false",
    context_to_cleanup: "false",
  },
  vocab: {
    context_enabled: "false",
    context_to_asr: "false",
    context_to_cleanup: "false",
  },
  asr: {
    context_enabled: "true",
    context_to_asr: "true",
    context_to_cleanup: "false",
  },
  "asr+cleanup": {
    context_enabled: "true",
    context_to_asr: "true",
    context_to_cleanup: "true",
  },
};

function usage() {
  return `Usage:
  node scripts/eval-context/run.mjs --server <url> (--config <name> | --all) [--mode batch|stream|both] [--only <id,...>]

Configs: ${Object.keys(CONFIGS).join(", ")}

Environment:
  FREESTYLE_EVAL_SNAPSHOT_FILE  Absolute fixture file path shared with the server
  FREESTYLE_EVAL_SERVER_TOKEN   Optional bearer token for HTTP and WebSocket auth`;
}

function parseArgs(argv) {
  const args = {
    all: false,
    config: null,
    mode: "both",
    only: null,
    server: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--all":
        args.all = true;
        break;
      case "--config":
        args.config = argv[++index];
        break;
      case "--mode":
        args.mode = argv[++index];
        break;
      case "--only":
        args.only = argv[++index];
        break;
      case "--server":
        args.server = argv[++index];
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(
          `Unknown or incomplete argument: ${arg ?? "<missing>"}`,
        );
    }
  }

  if (!args.server) throw new Error("--server is required");
  if (args.all === Boolean(args.config)) {
    throw new Error("Choose exactly one of --config or --all");
  }
  if (args.config && !CONFIGS[args.config]) {
    throw new Error(`Unknown config: ${args.config}`);
  }
  if (!["batch", "stream", "both"].includes(args.mode)) {
    throw new Error("--mode must be batch, stream, or both");
  }

  const serverUrl = new URL(args.server);
  if (!["http:", "https:"].includes(serverUrl.protocol)) {
    throw new Error("--server must use http or https");
  }
  args.server = serverUrl.toString().replace(/\/$/, "");

  return args;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url, options, token) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(token),
      ...options.headers,
    },
  });
  const body = await response.text();
  let parsed;

  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  if (!response.ok) {
    const detail = parsed.detail ?? parsed.error ?? body;
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }
  return parsed;
}

async function readSettings(server, token, signal) {
  return fetchJson(
    `${server}/api/settings`,
    {
      method: "GET",
      signal,
    },
    token,
  );
}

async function putSetting(server, token, key, value, signal) {
  await fetchJson(
    `${server}/api/settings/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal,
    },
    token,
  );
}

async function deleteSetting(server, token, key) {
  await fetchJson(
    `${server}/api/settings/${encodeURIComponent(key)}`,
    { method: "DELETE" },
    token,
  );
}

async function applyConfig(server, token, config, signal) {
  for (const [key, value] of Object.entries(CONFIGS[config])) {
    await putSetting(server, token, key, value, signal);
  }
}

async function restoreSettings(server, token, original) {
  const errors = [];
  for (const key of SETTINGS_KEYS) {
    try {
      if (Object.hasOwn(original, key)) {
        await putSetting(server, token, key, original[key]);
      } else {
        await deleteSetting(server, token, key);
      }
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Could not restore settings:\n${errors.join("\n")}`);
  }
}

async function readOptionalFile(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function clearSnapshot(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeSnapshot(file, snapshot) {
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(tempFile, file);
}

async function restoreSnapshot(file, original) {
  if (original === null) {
    await clearSnapshot(file);
    return;
  }
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, original);
  await rename(tempFile, file);
}

function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new Error("corpus.json must contain a non-empty array");
  }

  const ids = new Set();
  for (const entry of corpus) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.text !== "string" ||
      typeof entry.speak !== "string" ||
      !Array.isArray(entry.terms) ||
      !Array.isArray(entry.tags)
    ) {
      throw new Error(`Invalid corpus entry: ${JSON.stringify(entry)}`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    for (const term of entry.terms) {
      if (!entry.text.includes(term)) {
        throw new Error(`${entry.id}: reference does not contain "${term}"`);
      }
    }
  }
}

function selectCorpus(corpus, only) {
  if (!only) return corpus;
  const requested = only
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error("--only must contain at least one corpus id");
  }
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown corpus id(s): ${unknown.join(", ")}`);
  }
  return requested.map((id) => byId.get(id));
}

function isTechnicalCandidate(value) {
  return (
    value.length >= 3 &&
    (value.startsWith("--") ||
      /[_/@.:+-]/.test(value) ||
      /\d/.test(value) ||
      /[a-z][A-Z]/.test(value) ||
      /[A-Z]{2}/.test(value))
  );
}

function snapshotCandidates(snapshot) {
  if (!snapshot) return [];
  const candidates = new Set();
  const values = [
    snapshot.app?.windowTitle,
    snapshot.app?.wmClass,
    snapshot.app?.url,
    snapshot.terminal?.paneText,
    snapshot.editor?.file,
    snapshot.editor?.language,
    snapshot.editor?.visibleText,
    ...(snapshot.editor?.symbols ?? []),
    ...(snapshot.editor?.openBuffers ?? []),
    snapshot.focusText?.before,
    snapshot.focusText?.selected,
    snapshot.focusText?.after,
  ].filter((value) => typeof value === "string");

  for (const value of values) {
    if (!value.includes(" ") && isTechnicalCandidate(value)) {
      candidates.add(value);
    }
    for (const token of value.match(/[A-Za-z0-9@-][A-Za-z0-9_@./:+-]*/g) ??
      []) {
      const candidate = token.replace(/[.:+-]+$/, "");
      if (isTechnicalCandidate(candidate)) candidates.add(candidate);
    }
  }
  return [...candidates].sort();
}

async function readWav(entry) {
  const file = path.join(RECORDINGS_DIR, `${entry.id}.wav`);
  const wav = await readFile(file);
  if (
    wav.length <= PCM_HEADER_BYTES ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`${file} is not a supported WAV file`);
  }
  const pcm = wav.subarray(PCM_HEADER_BYTES);
  return {
    wav,
    pcm,
    audioDurationMs: Math.round(pcm.length / 32),
  };
}

async function runBatch(server, token, audio, signal) {
  const result = await fetchJson(
    `${server}/api/transcribe`,
    {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "x-audio-duration-ms": String(audio.audioDurationMs),
      },
      body: audio.wav,
      signal,
    },
    token,
  );

  if (typeof result.raw !== "string" || typeof result.cleaned !== "string") {
    throw new Error("Batch response did not contain raw and cleaned strings");
  }

  return {
    raw: result.raw,
    cleaned: result.cleaned,
    durationMs:
      typeof result.durationMs === "number" ? result.durationMs : null,
    commitToFinalMs: null,
  };
}

class MessageQueue {
  constructor(socket, signal) {
    this.socket = socket;
    this.signal = signal;
    this.sequence = 0;
    this.messages = [];
    this.waiters = new Set();

    this.onMessage = (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const item = { sequence: ++this.sequence, message };
      this.messages.push(item);
      for (const waiter of [...this.waiters]) {
        this.resolveWaiter(waiter, item);
      }
    };
    this.onClose = () => {
      for (const waiter of this.waiters) {
        waiter.reject(
          new Error("WebSocket closed before the expected message"),
        );
        waiter.cleanup();
      }
      this.waiters.clear();
    };

    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
  }

  resolveWaiter(waiter, item) {
    if (item.sequence <= waiter.after) return;
    if (item.message.type === "error") {
      this.waiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(
        new Error(
          `Stream error${item.message.code ? ` (${item.message.code})` : ""}: ${
            item.message.message ?? "unknown error"
          }`,
        ),
      );
      return;
    }
    if (!waiter.predicate(item.message)) return;

    this.waiters.delete(waiter);
    waiter.cleanup();
    waiter.resolve(item.message);
  }

  waitFor(predicate, after, label) {
    if (this.signal.aborted) {
      return Promise.reject(this.signal.reason ?? new Error("Interrupted"));
    }
    for (const item of this.messages) {
      if (item.sequence > after && item.message.type === "error") {
        return Promise.reject(
          new Error(`Stream error: ${item.message.message ?? "unknown error"}`),
        );
      }
      if (item.sequence > after && predicate(item.message)) {
        return Promise.resolve(item.message);
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        predicate,
        resolve,
        reject,
        timeout: null,
        onAbort: null,
        cleanup: null,
      };
      waiter.cleanup = () => {
        clearTimeout(waiter.timeout);
        this.signal.removeEventListener("abort", waiter.onAbort);
      };
      waiter.onAbort = () => {
        this.waiters.delete(waiter);
        waiter.cleanup();
        reject(this.signal.reason ?? new Error("Interrupted"));
      };
      waiter.timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        waiter.cleanup();
        reject(new Error(`Timed out waiting for ${label}`));
      }, STREAM_TIMEOUT_MS);
      this.signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  dispose() {
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    for (const waiter of this.waiters) waiter.cleanup();
    this.waiters.clear();
  }
}

function websocketUrl(server, token) {
  const url = new URL("/stream", `${server}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function openWebSocket(url, signal) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue = new MessageQueue(socket, signal);
    const timeout = setTimeout(() => {
      cleanup();
      queue.dispose();
      socket.close();
      reject(new Error("Timed out opening WebSocket"));
    }, STREAM_TIMEOUT_MS);

    const onOpen = () => {
      cleanup();
      resolve({ socket, queue });
    };
    const onError = () => {
      cleanup();
      queue.dispose();
      socket.close();
      reject(new Error("Could not open WebSocket"));
    };
    const onAbort = () => {
      cleanup();
      queue.dispose();
      socket.close();
      reject(signal.reason ?? new Error("Interrupted"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runStream(server, token, audio, signal) {
  const { socket, queue } = await openWebSocket(
    websocketUrl(server, token),
    signal,
  );

  try {
    const initialConfig = await queue.waitFor(
      (message) => message.type === "config",
      0,
      "initial stream config",
    );
    if (!initialConfig.sessionTransport) {
      throw new Error(
        "The selected voice provider does not support the /stream session transport",
      );
    }

    const startMarker = queue.sequence;
    socket.send(JSON.stringify({ type: "start" }));
    await queue.waitFor(
      (message) => message.type === "session.ready",
      startMarker,
      "session.ready after start",
    );

    for (let offset = 0; offset < audio.pcm.length; offset += PCM_CHUNK_BYTES) {
      const chunk = audio.pcm.subarray(offset, offset + PCM_CHUNK_BYTES);
      socket.send(chunk);
      await delay(chunk.length / 32, signal);
    }

    const commitMarker = queue.sequence;
    const committedAt = performance.now();
    socket.send(
      JSON.stringify({
        type: "commit",
        audioDurationMs: audio.audioDurationMs,
      }),
    );
    const final = await queue.waitFor(
      (message) => message.type === "final",
      commitMarker,
      "final transcript",
    );

    return {
      raw: null,
      cleaned: typeof final.text === "string" ? final.text : "",
      durationMs: null,
      commitToFinalMs: Math.round(performance.now() - committedAt),
    };
  } finally {
    queue.dispose();
    socket.close();
  }
}

function resultBase(entry, config, mode) {
  return {
    config,
    mode,
    id: entry.id,
    reference: entry.text,
    speak: entry.speak,
    terms: entry.terms,
    tags: entry.tags,
    snapshotCandidates: snapshotCandidates(entry.snapshot),
    recordedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.FREESTYLE_EVAL_SERVER_TOKEN?.trim() ?? "";
  const snapshotFile = process.env.FREESTYLE_EVAL_SNAPSHOT_FILE;
  if (!snapshotFile || !path.isAbsolute(snapshotFile)) {
    throw new Error(
      "FREESTYLE_EVAL_SNAPSHOT_FILE must be set to an absolute path",
    );
  }

  const corpus = JSON.parse(await readFile(CORPUS_FILE, "utf8"));
  validateCorpus(corpus);
  const entries = selectCorpus(corpus, args.only);
  const configs = args.all ? Object.keys(CONFIGS) : [args.config];
  const modes = args.mode === "both" ? ["batch", "stream"] : [args.mode];

  const audioById = new Map();
  for (const entry of entries) {
    audioById.set(entry.id, await readWav(entry));
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  await mkdir(path.dirname(snapshotFile), { recursive: true });

  const originalSnapshot = await readOptionalFile(snapshotFile);
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    controller.abort(new Error("Interrupted"));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const originalSettings = await readSettings(
    args.server,
    token,
    controller.signal,
  );
  const resultFiles = new Map();
  const errors = [];
  const restoreErrors = [];
  let runError = null;

  try {
    for (const config of configs) {
      if (controller.signal.aborted) throw controller.signal.reason;
      console.log(`\nConfig: ${config}`);
      await applyConfig(args.server, token, config, controller.signal);

      for (const mode of modes) {
        const resultPath = path.join(RESULTS_DIR, `${config}-${mode}.jsonl`);
        const resultFile = await open(resultPath, "w");
        resultFiles.set(`${config}:${mode}`, resultFile);

        for (const entry of entries) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const base = resultBase(entry, config, mode);
          console.log(`  ${mode.padEnd(6)} ${entry.id}`);

          try {
            if (entry.snapshot) {
              await writeSnapshot(snapshotFile, {
                ...entry.snapshot,
                capturedAt: Date.now(),
              });
            } else {
              await clearSnapshot(snapshotFile);
            }

            const audio = audioById.get(entry.id);
            const result =
              mode === "batch"
                ? await runBatch(args.server, token, audio, controller.signal)
                : await runStream(args.server, token, audio, controller.signal);
            await resultFile.write(
              `${JSON.stringify({ ...base, ...result })}\n`,
            );
          } catch (error) {
            if (controller.signal.aborted) throw error;
            errors.push(`${config}/${mode}/${entry.id}: ${error.message}`);
            await resultFile.write(
              `${JSON.stringify({ ...base, error: error.message })}\n`,
            );
            console.error(`    ERROR: ${error.message}`);
          } finally {
            await clearSnapshot(snapshotFile);
          }
        }
      }
    }
  } catch (error) {
    runError = error;
  } finally {
    for (const file of resultFiles.values()) {
      try {
        await file.close();
      } catch (error) {
        restoreErrors.push(`Could not close a result file: ${error.message}`);
      }
    }
    try {
      await clearSnapshot(snapshotFile);
    } catch (error) {
      restoreErrors.push(`Could not clear snapshot file: ${error.message}`);
    }

    try {
      await restoreSettings(args.server, token, originalSettings);
    } catch (error) {
      restoreErrors.push(error.message);
    }
    try {
      await restoreSnapshot(snapshotFile, originalSnapshot);
    } catch (error) {
      restoreErrors.push(`Could not restore snapshot file: ${error.message}`);
    }

    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }

  if (restoreErrors.length > 0) {
    const messages = runError
      ? [`Run failed: ${runError.message}`, ...restoreErrors]
      : restoreErrors;
    throw new Error(messages.join("\n"));
  }
  if (runError) throw runError;

  console.log(`\nWrote results to ${RESULTS_DIR}`);
  if (errors.length > 0) {
    console.error(`Completed with ${errors.length} failed request(s).`);
    process.exitCode = 1;
  }
  if (interrupted) process.exitCode = 130;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.message === "Interrupted" ? 130 : 1;
});
