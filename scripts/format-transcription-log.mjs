#!/usr/bin/env node
// Pretty-print the per-dictation transcription debug log
// (<userData>/transcriptions.jsonl, written when the
// transcription_debug_log setting is on). Reads JSONL from stdin so it
// works for both a full dump and `tail -F` follow mode. See `just
// transcriptions`.

import { createInterface } from "node:readline";

const useColor = process.stdout.isTTY;
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);

const EXCERPT_LINES = 3;
const TERMS_SHOWN = 15;

function fmtTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toTimeString().slice(0, 8);
}

function fmtTimings(t = {}) {
  const parts = [];
  if (t.contextMs !== undefined) parts.push(`context ${t.contextMs}ms`);
  if (t.sttMs !== undefined) parts.push(`stt ${t.sttMs}ms`);
  if (t.handoffMs !== undefined) parts.push(`handoff ${t.handoffMs}ms`);
  if (t.llmMs !== undefined) parts.push(`llm ${t.llmMs}ms`);
  if (t.totalMs !== undefined) parts.push(`total ${t.totalMs}ms`);
  return parts.join(" · ");
}

function fmtTermList(terms, shown = TERMS_SHOWN) {
  if (!terms?.length) return dim("(none)");
  const head = terms.slice(0, shown).join(", ");
  const rest = terms.length > shown ? dim(` … +${terms.length - shown}`) : "";
  return `${head}${rest} ${dim(`(${terms.length})`)}`;
}

function printEntry(e) {
  const models = [e.voiceModel, e.llmModel].filter(Boolean).join(" → ");
  console.log(
    `${dim("───")} ${bold(fmtTime(e.ts))} ${cyan(e.source ?? "?")}  ${dim(models)}`,
  );
  const timings = fmtTimings(e.timings);
  if (timings) console.log(`  ${dim(timings)}`);
  console.log(`  ${dim("raw:")}     ${e.raw ?? ""}`);
  const changed = e.cleaned !== e.raw;
  console.log(
    `  ${dim("cleaned:")} ${changed ? green(e.cleaned ?? "") : dim("(unchanged)")}`,
  );
  if (e.context) {
    console.log(`  ${dim("terms:")}   ${fmtTermList(e.context.terms)}`);
    const cleanup = e.context.cleanup;
    if (cleanup?.spellings?.length) {
      console.log(`  ${dim("spell:")}   ${fmtTermList(cleanup.spellings)}`);
    }
    if (cleanup?.excerpt) {
      const lines = cleanup.excerpt.split("\n");
      for (const line of lines.slice(-EXCERPT_LINES)) {
        console.log(`  ${dim("excerpt:")} ${dim("│")} ${line}`);
      }
      if (lines.length > EXCERPT_LINES) {
        console.log(
          `  ${dim("excerpt:")} ${dim(`… ${lines.length - EXCERPT_LINES} more lines`)}`,
        );
      }
    }
  }
  console.log();
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    printEntry(JSON.parse(trimmed));
  } catch {
    console.log(dim(`(unparseable line) ${trimmed.slice(0, 120)}`));
  }
});
