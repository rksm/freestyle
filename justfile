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
