import {
  type ContextSnapshot,
  parseContextSnapshot,
} from "@freestyle-voice/validations";
import {
  buildVocabularyNoteText,
  loadVocabularyEntries,
} from "./vocabulary.js";

export interface RecognitionContext {
  /** Merged, ranked, deduped bias terms: static vocabulary first, then plugin terms, then contextual terms. */
  terms: string[];
  /** Vocabulary notes text, unchanged by context. */
  noteText?: string;
  /** Context handed to cleanup when usable context is available. */
  cleanup?: { spellings: string[]; excerpt?: string };
}

interface Candidate {
  term: string;
  sourceWeight: number;
  occurrences: number;
  specificity: number;
  order: number;
}

const MAX_TERMS = 500;
const MAX_CLEANUP_SPELLINGS = 40;
const MAX_EXCERPT_CHARS = 600;

const COMMON_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "these",
  "those",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "could",
  "should",
  "would",
  "will",
  "into",
  "about",
  "than",
  "then",
  "when",
  "where",
  "what",
  "which",
  "while",
]);

const SENSITIVE_ASSIGNMENT =
  /(\b[A-Za-z_][A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER)[A-Za-z0-9_-]*\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/gi;

function redactText(text: string): string {
  return text
    .replace(PEM_BLOCK, "")
    .replace(SENSITIVE_ASSIGNMENT, "$1[redacted]");
}

function looksLikeSecret(term: string): boolean {
  if (
    /^sk-[A-Za-z0-9_-]+$/i.test(term) ||
    /^ghp_[A-Za-z0-9_]+$/i.test(term) ||
    /^xox[baprs]-[A-Za-z0-9-]+$/i.test(term) ||
    /^AKIA[A-Z0-9]{12,}$/.test(term)
  ) {
    return true;
  }

  return (
    term.length >= 32 &&
    /^[A-Za-z0-9]+$/.test(term) &&
    /[a-z]/.test(term) &&
    /[A-Z]/.test(term) &&
    /\d/.test(term)
  );
}

function isIdentifierLike(
  term: string,
  quoted: boolean,
  lowercaseSymbols: Set<string>,
): boolean {
  if (
    term.length < 3 ||
    /^\d+$/.test(term) ||
    COMMON_WORDS.has(term.toLowerCase()) ||
    looksLikeSecret(term)
  ) {
    return false;
  }
  if (quoted) return true;

  const hasLetter = /[A-Za-z]/.test(term);
  if (!hasLetter) return false;

  const lower = term.toLowerCase();
  if (/^[a-z]+$/.test(term)) return lowercaseSymbols.has(lower);

  const mixedCase =
    /[a-z]/.test(term) && /[A-Z]/.test(term) && /[A-Z]/.test(term.slice(1));
  const snakeCase = /[A-Za-z0-9]+_[A-Za-z0-9]+/.test(term);
  const kebabCase = /[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]*[A-Za-z]/.test(term);
  const dotted = /[A-Za-z0-9]\.[A-Za-z0-9]/.test(term);
  const path = term.includes("/");
  const mixedAlphanumeric = /[A-Za-z]/.test(term) && /\d/.test(term);
  const acronym = /^[A-Z]{3,}$/.test(term);

  return (
    mixedCase ||
    snakeCase ||
    kebabCase ||
    dotted ||
    path ||
    mixedAlphanumeric ||
    acronym
  );
}

function dedupeTerms(groups: string[][], max: number): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length === max) return terms;
    }
  }
  return terms;
}

export function buildRecognitionContext(opts: {
  snapshot?: ContextSnapshot | null;
  /** Terms from beforeTranscribe augment persistent vocabulary. */
  pluginTerms?: string[];
  /** Exclude snapshot terms from ASR while retaining vocabulary and plugin terms. */
  contextToAsr?: boolean;
  /** Omit cleanup context when disabled. */
  contextToCleanup?: boolean;
}): RecognitionContext {
  const entries = loadVocabularyEntries();
  const vocabularyTerms = entries.map((entry) => entry.term);
  const pluginTerms = opts.pluginTerms ?? [];
  const snapshot = opts.snapshot ? parseContextSnapshot(opts.snapshot) : null;

  const lowercaseSymbols = new Set(
    (snapshot?.editor?.symbols ?? [])
      .map((symbol) => redactText(symbol).trim())
      .filter((symbol) => /^[a-z]+$/.test(symbol))
      .map((symbol) => symbol.toLowerCase()),
  );
  const candidates = new Map<string, Candidate>();
  let order = 0;

  const addCandidate = (raw: string, sourceWeight: number, quoted: boolean) => {
    const term = raw.trim();
    if (!isIdentifierLike(term, quoted, lowercaseSymbols)) return;

    const key = term.toLowerCase();
    const existing = candidates.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.sourceWeight = Math.max(existing.sourceWeight, sourceWeight);
      return;
    }

    candidates.set(key, {
      term,
      sourceWeight,
      occurrences: 1,
      specificity:
        /\d/.test(term) || /[A-Z]/.test(term.slice(1)) || /[_./-]/.test(term)
          ? 1
          : 0,
      order,
    });
    order += 1;
  };

  const extract = (text: string | undefined, sourceWeight: number) => {
    if (!text) return;
    const redacted = redactText(text);
    const unquoted = redacted.replace(
      /`([^`\r\n]{1,60})`|"([^"\r\n]{1,60})"|'([^'\r\n]{1,60})'/g,
      (match, backtick: string, double: string, single: string) => {
        addCandidate(backtick ?? double ?? single, sourceWeight, true);
        return " ".repeat(match.length);
      },
    );

    for (const match of unquoted.matchAll(/[A-Za-z0-9_./-]+/g)) {
      const term = match[0].replace(/[_.\\/-]+$/, "");
      addCandidate(term, sourceWeight, false);
    }
  };

  // High-signal sources run first so ties and retained casing follow priority.
  for (const symbol of snapshot?.editor?.symbols ?? []) extract(symbol, 5);
  extract(snapshot?.focusText?.selected, 4);
  extract(snapshot?.editor?.visibleText, 3);
  extract(snapshot?.terminal?.paneText, 3);
  extract(snapshot?.focusText?.before, 3);
  extract(snapshot?.focusText?.after, 3);
  for (const buffer of snapshot?.editor?.openBuffers ?? []) extract(buffer, 2);
  extract(snapshot?.app?.windowTitle, 2);

  const contextualTerms = [...candidates.values()]
    .sort((left, right) => {
      const leftScore =
        left.sourceWeight +
        Math.min(left.occurrences - 1, 3) +
        left.specificity;
      const rightScore =
        right.sourceWeight +
        Math.min(right.occurrences - 1, 3) +
        right.specificity;
      return rightScore - leftScore || left.order - right.order;
    })
    .map((candidate) => candidate.term);

  const noteText = buildVocabularyNoteText(entries);
  const terms = dedupeTerms(
    [
      vocabularyTerms,
      pluginTerms,
      opts.contextToAsr === false ? [] : contextualTerms,
    ],
    MAX_TERMS,
  );

  let cleanup: RecognitionContext["cleanup"];
  if (opts.contextToCleanup !== false) {
    const spellings = dedupeTerms(
      [pluginTerms, contextualTerms],
      MAX_CLEANUP_SPELLINGS,
    );
    const selected = snapshot?.focusText?.selected;
    const visibleText = snapshot?.editor?.visibleText;
    const paneText = snapshot?.terminal?.paneText;
    const excerptSource = selected?.trim()
      ? selected
      : visibleText?.trim()
        ? visibleText
        : paneText;
    const excerpt = excerptSource
      ? redactText(excerptSource).trim().slice(-MAX_EXCERPT_CHARS)
      : "";

    if (spellings.length > 0 || excerpt) {
      cleanup = {
        spellings,
        ...(excerpt ? { excerpt } : {}),
      };
    }
  }

  return {
    terms,
    ...(noteText ? { noteText } : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}
