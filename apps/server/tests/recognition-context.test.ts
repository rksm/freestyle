import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import { buildRecognitionContext } from "../src/lib/recognition-context.js";
import { resolveAsrVocabularyBias } from "../src/lib/vocabulary-bias.js";

function terminalSnapshot(paneText: string) {
  return { capturedAt: 1, terminal: { paneText } };
}

describe("buildRecognitionContext", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM vocabulary").run();
  });

  describe("term extraction", () => {
    it.each([
      ["camelCase", "getScreenContext", ["getScreenContext"]],
      ["PascalCase", "AccessibilityDumpResult", ["AccessibilityDumpResult"]],
      ["snake_case", "resolve_bias", ["resolve_bias"]],
      ["UPPER_SNAKE", "RUST_LOG", ["RUST_LOG"]],
      ["kebab-case", "post-process", ["post-process"]],
      ["dotted name", "foo.bar.baz", ["foo.bar.baz"]],
      ["filename", "app.tsx", ["app.tsx"]],
      ["path", "src/lib/app.tsx", ["src/lib/app.tsx"]],
      ["hyphenated alphanumeric", "nova-3", ["nova-3"]],
      ["mixed alphanumeric", "sha256", ["sha256"]],
      ["backtick quote", "`exact spelling`", ["exact spelling"]],
      ["single quote", "'short phrase'", ["short phrase"]],
      ["double quote", '"another phrase"', ["another phrase"]],
    ])("extracts %s", (_shape, input, expected) => {
      expect(
        buildRecognitionContext({
          snapshot: terminalSnapshot(input),
        }).terms,
      ).toEqual(expected);
    });

    it("allows plain lowercase words only when supplied as editor symbols", () => {
      const context = buildRecognitionContext({
        snapshot: {
          capturedAt: 1,
          editor: {
            symbols: ["index"],
            visibleText: "index helper",
          },
        },
      });

      expect(context.terms).toEqual(["index"]);
    });

    it("does not extract prose or ordinary capitalized nouns", () => {
      const context = buildRecognitionContext({
        snapshot: terminalSnapshot(
          "The quick brown fox works with Berlin and another ordinary sentence.",
        ),
      });

      expect(context.terms).toEqual([]);
    });

    it("filters opaque secrets and generated identifiers", () => {
      const context = buildRecognitionContext({
        snapshot: terminalSnapshot(
          [
            "resolveRecognitionContextSnapshot",
            "OAuth2AuthorizationRequest",
            "2026-07-29_review_pr-5250.org",
            "019fad67-9c8a-70e1-876b-9429c805cf89",
            "0123456789abcdef0123456789abcdef01234567",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "/nix/store/zp6rsi809fx5h7dccn7aidg1mj8zgn52-bubblewrap/bin/bwrap",
            "x7p9q2m4n8v6c3b5z1k0r2t4",
          ].join(" "),
        ),
      });

      expect(context.terms).toEqual([
        "resolveRecognitionContextSnapshot",
        "OAuth2AuthorizationRequest",
        "2026-07-29_review_pr-5250.org",
      ]);
    });

    it("filters transient environment noise", () => {
      const context = buildRecognitionContext({
        snapshot: terminalSnapshot(
          "/dev /etc /nix /proc /run /sys /tmp /var /home/robert 21s 12000ms usefulTerm",
        ),
      });

      expect(context.terms).toEqual(["usefulTerm"]);
    });

    it("keeps specific filesystem paths", () => {
      const context = buildRecognitionContext({
        snapshot: terminalSnapshot(
          "/etc/nixos /home/robert/projects/freestyle",
        ),
      });

      expect(context.terms).toEqual([
        "/etc/nixos",
        "/home/robert/projects/freestyle",
      ]);
    });
  });

  describe("ranking", () => {
    it("ranks symbols above visible text and visible text above window titles", () => {
      const context = buildRecognitionContext({
        snapshot: {
          capturedAt: 1,
          app: { name: "Editor", windowTitle: "windowTitleTerm" },
          editor: {
            symbols: ["symbolTerm"],
            visibleText: "visibleTextTerm",
          },
        },
      });

      expect(context.terms).toEqual([
        "symbolTerm",
        "visibleTextTerm",
        "windowTitleTerm",
      ]);
    });

    it("uses repeats to break equal-source ties", () => {
      const context = buildRecognitionContext({
        snapshot: {
          capturedAt: 1,
          editor: {
            visibleText: "singleTerm repeatedTerm repeatedTerm repeatedTerm",
          },
        },
      });

      expect(context.terms).toEqual(["repeatedTerm", "singleTerm"]);
    });

    it("keeps the first-seen casing for case-insensitive identities", () => {
      const context = buildRecognitionContext({
        snapshot: {
          capturedAt: 1,
          editor: {
            symbols: ["contextTerm"],
            visibleText: "ContextTerm",
          },
        },
      });

      expect(context.terms).toEqual(["contextTerm"]);
    });
  });

  it("redacts secrets from terms and excerpts", () => {
    const randomToken = `Ab3${"x".repeat(37)}`;
    const context = buildRecognitionContext({
      snapshot: {
        capturedAt: 1,
        focusText: {
          before: "",
          selected: [
            "sk-secretvalue",
            randomToken,
            "API_TOKEN=visible-secret",
            "-----BEGIN PRIVATE KEY-----",
            "PrivateKeyMaterial123",
            "-----END PRIVATE KEY-----",
          ].join("\n"),
        },
      },
    });

    expect(context.terms).not.toContain("sk-secretvalue");
    expect(context.terms).not.toContain(randomToken);
    expect(context.terms).not.toContain("PrivateKeyMaterial123");
    expect(context.cleanup?.excerpt).toContain("API_TOKEN=[redacted]");
    expect(context.cleanup?.excerpt).not.toContain("visible-secret");
    expect(context.cleanup?.excerpt).not.toContain("PRIVATE KEY");
  });

  it("merges vocabulary, plugin terms, and context in priority order", () => {
    const db = getDb();
    db.prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)").run(
      "VocabularyLongTerm",
      "persistent note",
    );
    db.prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)").run(
      "React",
      null,
    );

    const context = buildRecognitionContext({
      pluginTerms: ["PluginTerm", "react"],
      snapshot: {
        capturedAt: 1,
        editor: {
          visibleText: "ContextTerm pluginTerm VocabularyLongTerm",
        },
      },
    });

    expect(context.terms).toEqual([
      "VocabularyLongTerm",
      "React",
      "PluginTerm",
      "ContextTerm",
    ]);
    expect(context.noteText).toBe("VocabularyLongTerm: persistent note");
  });

  it("can exclude contextual ASR terms without excluding vocabulary or plugin terms", () => {
    getDb()
      .prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)")
      .run("VocabularyTerm", null);

    const context = buildRecognitionContext({
      pluginTerms: ["PluginTerm"],
      contextToAsr: false,
      snapshot: terminalSnapshot("ContextTerm"),
    });

    expect(context.terms).toEqual(["VocabularyTerm", "PluginTerm"]);
    expect(context.cleanup?.spellings).toEqual(["PluginTerm", "ContextTerm"]);
  });

  it("omits cleanup context when disabled", () => {
    const context = buildRecognitionContext({
      pluginTerms: ["PluginTerm"],
      contextToCleanup: false,
      snapshot: terminalSnapshot("ContextTerm"),
    });

    expect(context.cleanup).toBeUndefined();
  });

  it("bounds cleanup spellings and excerpts", () => {
    const context = buildRecognitionContext({
      snapshot: {
        capturedAt: 1,
        editor: {
          symbols: Array.from({ length: 60 }, (_, index) => `symbol${index}`),
          visibleText: "x".repeat(800),
        },
      },
    });

    expect(context.cleanup?.spellings.length).toBeLessThanOrEqual(40);
    expect(context.cleanup?.excerpt?.length).toBeLessThanOrEqual(600);
  });

  it("uses surrounding focused text as the cleanup excerpt", () => {
    const context = buildRecognitionContext({
      snapshot: {
        capturedAt: 1,
        focusText: {
          before: "Please keep the spelling resolveRecognitionContext",
          after: "in the response",
        },
      },
    });

    expect(context.cleanup?.excerpt).toBe(
      "Please keep the spelling resolveRecognitionContext\nin the response",
    );
    expect(context.terms).toEqual(["resolveRecognitionContext"]);
  });
});

describe("resolveAsrVocabularyBias with recognition context", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM vocabulary").run();
  });

  it("uses provided terms instead of loading vocabulary", () => {
    getDb()
      .prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)")
      .run("DatabaseTerm", null);

    const bias = resolveAsrVocabularyBias("deepgram", "nova-3", false, {
      terms: ["ContextTerm"],
    });

    expect(bias).toEqual({
      kind: "deepgram-keyterms",
      terms: ["ContextTerm"],
    });
  });
});
