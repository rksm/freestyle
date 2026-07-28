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
            ];
          };
        }
    );
}
