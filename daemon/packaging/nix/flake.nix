{
  description = "Open Anonymity daemon native release packages and user services";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/cf5e76507c6e23b59f7e0ffcc7baa2a39ddd8442";
  # Used by module evaluation checks, with the same locked package set.
  inputs.home-manager = {
    url = "github:nix-community/home-manager/a6631107a83ceab5872f298a2ea710859c80c4cb";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, home-manager }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          oa-chat = pkgs.callPackage ./package.nix { };
        in { inherit oa-chat; default = oa-chat; });

      apps = eachSystem (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.oa-chat}/bin/oa-chat";
        };
      });

      checks = eachSystem (system: { package = self.packages.${system}.oa-chat; });

      overlays.default = final: prev: {
        oa-chat = final.callPackage ./package.nix { };
      };

      nixosModules.default = import ./nixos-module.nix;
      homeManagerModules.default = import ./home-manager-module.nix;
    };
}
