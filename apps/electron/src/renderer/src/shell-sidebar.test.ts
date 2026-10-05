import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shellPath = resolve(dirname(fileURLToPath(import.meta.url)), "shell.tsx");
const shellStylesPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "shell.css",
);

describe("sidebar shell", () => {
  it("loads shared sidebar styles with the shell", async () => {
    const shell = await readFile(shellPath, "utf8");

    expect(shell).toContain('import "./shell.css"');
  });

  it("shows only the dictation navigation, with no Remix workspace", async () => {
    const shell = await readFile(shellPath, "utf8");

    expect(shell).not.toContain("WorkspaceSwitcher");
    expect(shell).not.toContain("RemixSidebarSessions");
    expect(shell).not.toContain("useRemixSession");
    expect(shell).not.toContain("CloudProfileButton");
    expect(shell).not.toContain("UpgradeCtaCard");
    expect(shell).toContain('className="remix-sidebar-titlebar"');
    expect(shell).toContain("onFullscreenChanged(setIsFullscreen)");
    expect(shell).toContain('IS_MAC && !isFullscreen ? "h-8" : "h-0"');
    expect(shell).toContain("<NavList items={footerNav} />");
    expect(shell).toContain('to: "/settings/models"');
    expect(shell).toContain("icon: Cpu");
    expect(shell).not.toContain("advancedMode");
    expect(shell).not.toContain("settingsQueryOptions");
  });

  it("offers no cloud-only settings sections", async () => {
    const shell = await readFile(shellPath, "utf8");
    const settingsNavigation = shell.slice(
      shell.indexOf("const SETTINGS_NAV_GROUPS"),
      shell.indexOf("function NavList"),
    );

    for (const route of ["remix", "mcp", "apps", "notifications", "billing"]) {
      expect(settingsNavigation).not.toContain(`to: "/settings/${route}"`);
    }
  });

  it("keeps the development badge in the titlebar", async () => {
    const shell = await readFile(shellPath, "utf8");
    const styles = await readFile(shellStylesPath, "utf8");

    expect(shell).toContain('className="remix-dev-badge"');
    expect(shell).toContain('title="Development build"');
    expect(styles).toContain(".remix-dev-badge");
    expect(styles).toContain("height: 18px;");
  });
});
