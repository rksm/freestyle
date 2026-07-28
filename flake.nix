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
          };
        }
    );
}
