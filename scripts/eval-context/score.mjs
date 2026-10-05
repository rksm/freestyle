import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage:
  node scripts/eval-context/score.mjs [--results <directory>]
  node scripts/eval-context/score.mjs --self-test`;
}

function parseArgs(argv) {
  const args = {
    results: path.resolve("scripts/eval-context/results"),
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--results":
        args.results = path.resolve(argv[++index]);
        break;
      case "--self-test":
        args.selfTest = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(
          `Unknown or incomplete argument: ${argv[index] ?? "<missing>"}`,
        );
    }
  }
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(text, term, caseSensitive) {
  if (!text || !term) return false;
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(term)}(?=$|[^A-Za-z0-9_])`,
    caseSensitive ? "" : "i",
  );
  return pattern.test(text);
}

function rate(hits, total) {
  return total === 0 ? null : (hits / total) * 100;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function computeMetrics(rows) {
  const successful = rows.filter((row) => !row.error);
  let rawHits = 0;
  let rawTerms = 0;
  let cleanedHits = 0;
  let cleanedTerms = 0;
  let corruptions = 0;
  let corruptionCandidates = 0;
  let insertionRows = 0;
  let insertionCandidates = 0;
  const latencies = [];

  for (const row of successful) {
    const terms = Array.isArray(row.terms) ? row.terms : [];
    for (const term of terms) {
      if (typeof row.raw === "string") {
        rawTerms += 1;
        if (containsTerm(row.raw, term, false)) rawHits += 1;
      }
      if (typeof row.cleaned === "string") {
        cleanedTerms += 1;
        if (containsTerm(row.cleaned, term, true)) cleanedHits += 1;
      }
      if (typeof row.raw === "string" && containsTerm(row.raw, term, true)) {
        corruptionCandidates += 1;
        if (!containsTerm(row.cleaned, term, true)) corruptions += 1;
      }
    }

    const candidates = [
      ...new Set(
        Array.isArray(row.snapshotCandidates) ? row.snapshotCandidates : [],
      ),
    ].filter(
      (candidate) =>
        typeof candidate === "string" &&
        !containsTerm(row.reference, candidate, false),
    );
    if (typeof row.cleaned === "string" && candidates.length > 0) {
      insertionCandidates += 1;
      if (
        candidates.some((candidate) =>
          containsTerm(row.cleaned, candidate, true),
        )
      ) {
        insertionRows += 1;
      }
    }

    if (
      typeof row.commitToFinalMs === "number" &&
      Number.isFinite(row.commitToFinalMs)
    ) {
      latencies.push(row.commitToFinalMs);
    }
  }

  return {
    rows: successful.length,
    errors: rows.length - successful.length,
    rawRecall: rate(rawHits, rawTerms),
    cleanedExact: rate(cleanedHits, cleanedTerms),
    corruptionRate: rate(corruptions, corruptionCandidates),
    insertionRate: rate(insertionRows, insertionCandidates),
    meanLatencyMs: mean(latencies),
    medianLatencyMs: median(latencies),
  };
}

function formatPercent(value) {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

function formatMs(value) {
  return value === null ? "-" : String(Math.round(value));
}

function printTable(groups) {
  const table = [
    [
      "Config",
      "Mode",
      "N",
      "Errors",
      "Raw recall",
      "Clean exact",
      "Corrupt",
      "Insert",
      "Mean ms",
      "Median ms",
    ],
  ];

  for (const group of groups) {
    const metrics = computeMetrics(group.rows);
    table.push([
      group.config,
      group.mode,
      String(metrics.rows),
      String(metrics.errors),
      formatPercent(metrics.rawRecall),
      formatPercent(metrics.cleanedExact),
      formatPercent(metrics.corruptionRate),
      formatPercent(metrics.insertionRate),
      formatMs(metrics.meanLatencyMs),
      formatMs(metrics.medianLatencyMs),
    ]);
  }

  const widths = table[0].map((_, column) =>
    Math.max(...table.map((row) => row[column].length)),
  );
  for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
    const row = table[rowIndex]
      .map((cell, column) =>
        column < 2
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join("  ");
    console.log(row);
    if (rowIndex === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("  "));
    }
  }
}

async function loadGroups(resultsDir) {
  const names = (await readdir(resultsDir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) {
    throw new Error(`No JSONL files found in ${resultsDir}`);
  }

  const grouped = new Map();
  for (const name of names) {
    const content = await readFile(path.join(resultsDir, name), "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`${name}:${index + 1}: ${error.message}`);
      }
      if (typeof row.config !== "string" || typeof row.mode !== "string") {
        throw new Error(`${name}:${index + 1}: config and mode are required`);
      }
      const key = `${row.config}\0${row.mode}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          config: row.config,
          mode: row.mode,
          rows: [],
        });
      }
      grouped.get(key).rows.push(row);
    }
  }
  return [...grouped.values()].sort((left, right) => {
    const configOrder = Object.keys({
      baseline: true,
      vocab: true,
      asr: true,
      "asr+cleanup": true,
    });
    const leftIndex = configOrder.indexOf(left.config);
    const rightIndex = configOrder.indexOf(right.config);
    const configDifference =
      (leftIndex === -1 ? configOrder.length : leftIndex) -
      (rightIndex === -1 ? configOrder.length : rightIndex);
    return (
      configDifference ||
      left.config.localeCompare(right.config) ||
      left.mode.localeCompare(right.mode)
    );
  });
}

function selfTest() {
  const rows = [
    {
      terms: ["getScreenContext", "RUST_LOG"],
      reference: "Call getScreenContext with RUST_LOG.",
      raw: "Call getScreenContext with RUST_LOG.",
      cleaned: "Call getScreenContext with rust_log.",
      snapshotCandidates: ["CacheInvalidator"],
      commitToFinalMs: 100,
    },
    {
      terms: [],
      reference: "Please buy apples.",
      raw: "Please buy apples.",
      cleaned: "Please buy apples with RetryBudget.",
      snapshotCandidates: ["RetryBudget"],
      commitToFinalMs: 300,
    },
  ];
  const metrics = computeMetrics(rows);
  assert.equal(metrics.rawRecall, 100);
  assert.equal(metrics.cleanedExact, 50);
  assert.equal(metrics.corruptionRate, 50);
  assert.equal(metrics.insertionRate, 50);
  assert.equal(metrics.meanLatencyMs, 200);
  assert.equal(metrics.medianLatencyMs, 200);
  console.log("score.mjs self-test passed");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  printTable(await loadGroups(args.results));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
