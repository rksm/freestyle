# Common dev commands. Run inside the nix dev shell (direnv provides
# nodejs + corepack, so `pnpm` resolves via the corepack shim).

# List available recipes.
default:
    @just --list

# Install workspace dependencies.
setup:
    pnpm install

# Run the desktop app in dev mode (electron-vite hot reload, embedded server).
dev:
    pnpm dev

# Build every workspace package (excludes docs).
build:
    pnpm build

# Build a Linux release of the desktop app (AppImage + deb in apps/electron/dist).
# Builds workspace dependencies first, then native helpers, renderer, and installers.
# USE_SYSTEM_FPM: electron-builder's downloaded fpm cannot run on NixOS; the
# dev shell provides fpm from nixpkgs instead.
release:
    pnpm exec turbo build --filter='@freestyle-voice/electron^...'
    USE_SYSTEM_FPM=true pnpm --filter @freestyle-voice/electron run build:linux

# Run all test suites.
test:
    pnpm test

# Fast loop: server tests only (the bulk of the suite).
test-server:
    pnpm --filter @freestyle-voice/server exec vitest run

# Typecheck the Electron main and renderer processes.
typecheck:
    pnpm --filter @freestyle-voice/electron run typecheck

# Check formatting and lint rules without writing.
lint:
    pnpm exec biome check .

# Fix formatting and lint issues.
format:
    pnpm format

# Run the context evaluation matrix against a running app (see scripts/eval-context/README.md).
eval-context *ARGS:
    node scripts/eval-context/run.mjs {{ARGS}}

# Install the built AppImage to the stable path the NixOS launcher and
# desktop item point at (/etc/nixos/shared/linux/freestyle.nix), and sync
# the /etc/nixos-managed pieces (GNOME extension, desktop-context plugin)
# so they match the code the AppImage was built from. Synced files still
# need a `just switch` in /etc/nixos to take effect.
install: release sync-gnome-extension sync-desktop-context-plugin
    #!/usr/bin/env sh
    set -e
    appimage=$(ls apps/electron/dist/Freestyle-*.AppImage 2>/dev/null | head -1)
    if [ -z "$appimage" ]; then
        echo "No AppImage in apps/electron/dist - run 'just release' first" >&2
        exit 1
    fi
    cp "$appimage" Freestyle.AppImage
    chmod +x Freestyle.AppImage
    echo "Installed $appimage -> Freestyle.AppImage"

# Sync the FocusBridge GNOME extension into the NixOS config repo
# (installed system-wide via /etc/nixos/shared/linux-home/gnome.nix;
# apply with `just switch` there, then log out/in to reload GNOME Shell).
sync-gnome-extension:
    cp integrations/gnome-focus-bridge/extension.js \
       integrations/gnome-focus-bridge/metadata.json \
       integrations/gnome-focus-bridge/README.md \
       /etc/nixos/packages/freestyle-focus-bridge/

# Build the desktop-context plugin and sync its self-contained bundle into
# the NixOS config repo (placed into ~/.config/Freestyle/plugins/ by
# /etc/nixos/shared/linux-home/freestyle.nix; apply with `just switch` there,
# then restart Freestyle).
sync-desktop-context-plugin:
    pnpm --filter @freestyle-voice/plugin-desktop-context build
    cp plugins/desktop-context/dist/index.js \
       /etc/nixos/packages/freestyle-desktop-context/desktop-context.mjs

# Pretty-print the per-dictation transcription debug log (enable it via the
# transcription_debug_log setting). Pass -f to follow live.
transcriptions *ARGS:
    #!/usr/bin/env sh
    set -e
    file="${FREESTYLE_TRANSCRIPTION_LOG:-$HOME/.config/Freestyle/transcriptions.jsonl}"
    if [ ! -e "$file" ]; then
        echo "No log at $file" >&2
        echo "Enable it, then dictate:" >&2
        echo "  curl -X PUT http://127.0.0.1:4649/api/settings/transcription_debug_log -H 'content-type: application/json' -d '{\"value\":\"true\"}'" >&2
        exit 1
    fi
    case "{{ARGS}}" in
        *-f*) tail -n 200 -F "$file" | node scripts/format-transcription-log.mjs ;;
        *) node scripts/format-transcription-log.mjs < "$file" ;;
    esac
