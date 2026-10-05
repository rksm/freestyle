{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; };
      in
        {
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              # pnpm is pinned via package.json#packageManager; corepack
              # provides the matching version on demand.
              pkgs.corepack
              pkgs.just
              # compile:native builds the Linux paste/hotkey helpers with gcc.
              pkgs.gcc
              # Nothing in the repo builds whisper.cpp any more; local Whisper
              # finds whisper-cli/whisper-server on PATH (lib/whisper/binary.ts).
              # cmake + make are only for building those by hand.
              pkgs.cmake
              pkgs.gnumake
              # electron-builder's downloaded fpm binary cannot run on NixOS;
              # `just release` sets USE_SYSTEM_FPM to use this one for the deb.
              pkgs.fpm
            ];
            # X11 headers/libs for linux-fast-paste (-lX11 -lXtst).
            buildInputs = [
              pkgs.libx11
              pkgs.libxtst
              # XTest.h transitively includes XInput.h (libxi) and Xext headers.
              pkgs.libxi
              pkgs.libxext
            ];
            # Electron/Chromium runtime for the npm-downloaded electron binary,
            # resolved through nix-ld (needs programs.nix-ld.enable in the
            # system config; the library list lives here, not there).
            env.NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (with pkgs; [
              alsa-lib
              at-spi2-atk
              at-spi2-core
              atk
              cairo
              cups
              dbus
              expat
              fontconfig
              freetype
              gdk-pixbuf
              glib
              gtk3
              libdrm
              libgbm
              libGL
              libxkbcommon
              mesa
              nspr
              nss
              pango
              stdenv.cc.cc.lib
              systemd
              wayland
              zlib
              libx11
              libxcb
              libxcomposite
              libxdamage
              libxext
              libxfixes
              libxrandr
            ]);
          };
        }
    );
}
