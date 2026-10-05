import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "dashboard.tsx",
);
const tonePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "pages/tone.tsx",
);

describe("dashboard routes", () => {
  it("keeps every Dictate sidebar destination on its dedicated page", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    const routes = [
      ["/vocabulary", "VocabularyPage"],
      ["/dictionary", "DictionaryPage"],
      ["/tone", "TonePage"],
      ["/plugins", "PluginsPage"],
      ["/plugins/:slug", "PluginDetailPage"],
      ["/plugins/:slug/:pageId", "PluginPage"],
    ] as const;

    for (const [path, page] of routes) {
      expect(dashboard).toMatch(
        new RegExp(
          `<Route\\s+path="${path}"\\s+element=\\{\\s*<LazyRoute>\\s*<${page}\\s*\\/>\\s*</LazyRoute>\\s*\\}\\s*\\/>`,
          "s",
        ),
      );
    }
  });

  it("keeps Models in Settings and redirects retired settings URLs", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    for (const [legacyPath, appPath] of [
      ["/settings/vocabulary", "/vocabulary"],
      ["/settings/dictionary", "/dictionary"],
      ["/settings/tone", "/tone"],
      ["/settings/companion", "/settings/transcription"],
    ]) {
      expect(dashboard).toMatch(
        new RegExp(
          `<Route\\s+path="${legacyPath}"\\s+element=\\{\\s*<Navigate\\s+to="${appPath}"\\s+replace\\s*\\/>\\s*\\}\\s*\\/>`,
          "s",
        ),
      );
    }

    expect(dashboard).toMatch(
      /<Route\s+path="\/settings\/models"\s+element=\{\s*<LazyRoute>\s*<ModelsPage\s*\/>\s*<\/LazyRoute>\s*\}\s*\/>/s,
    );
    expect(dashboard).toMatch(
      /<Route\s+path="\/models"\s+element=\{\s*<Navigate\s+to="\/settings\/models"\s+replace\s*\/>\s*\}\s*\/>/s,
    );
  });

  it("takes Dictate cleanup controls to the shared model settings", async () => {
    const tone = await readFile(tonePath, "utf8");

    expect(tone).toContain('<Link to="/settings/models">');
    expect(tone).not.toContain('to="/models"');
  });

  it("loads the legacy Models page as a route-level chunk", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    expect(dashboard).toContain(
      'const ModelsPage = lazy(() => import("@renderer/pages/models"))',
    );
  });

  it("renders the Help page for the user-menu destination", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    expect(dashboard).toContain('import HelpPage from "@renderer/pages/help"');
    expect(dashboard).toMatch(
      /<Route\s+path="\/help"\s+element=\{\s*<LazyRoute>\s*<HelpPage\s*\/>\s*<\/LazyRoute>\s*\}\s*\/>/s,
    );
  });

  it("opens the Today page at startup", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    expect(dashboard).toMatch(
      /<Route\s+path="\/"\s+element=\{\s*<Navigate\s+to="\/today"\s+replace\s*\/>\s*\}\s*\/>/s,
    );
  });

  it("redirects the cloud-only routes instead of mounting them", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");

    for (const path of ["/remix", "/onboarding", "/profile"]) {
      expect(dashboard).toMatch(
        new RegExp(
          `<Route\\s+path="${path}"\\s+element=\\{\\s*<Navigate\\s+to="/today"\\s+replace\\s*/>\\s*\\}\\s*/>`,
          "s",
        ),
      );
    }
    expect(dashboard).not.toContain("RemixSessionProvider");
    expect(dashboard).not.toContain("CloudSignInModal");
    expect(dashboard).not.toContain("UpgradeModalProvider");
  });
});
