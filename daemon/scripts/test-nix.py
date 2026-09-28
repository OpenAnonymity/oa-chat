#!/usr/bin/env python3
"""Evaluate generated Nix manifests/modules and build the host's local archive.

Usage: python3 daemon/scripts/test-nix.py RELEASE_ARTIFACTS [--archive ARCHIVE]
Needs Nix with flakes; only Nixpkgs/Home Manager and cached dependencies are
downloaded. The daemon archive is supplied locally, never fetched from a draft.
This checks packaging and executable startup, not funded inference or service boot.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


SYSTEMS = {
    "x86_64-linux": "linux_amd64",
    "aarch64-linux": "linux_arm64",
    "x86_64-darwin": "darwin_amd64",
    "aarch64-darwin": "darwin_arm64",
}
PROOF_FILES = ("request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk", "manifest.json")


def nix_string(value):
    return json.dumps(str(value), ensure_ascii=False).replace("${", r"\${")


def nix(*args):
    result = subprocess.run(
        ["nix", "--extra-experimental-features", "nix-command flakes", *args],
        check=True, text=True, stdout=subprocess.PIPE,
    )
    return result.stdout.strip()


def evaluate(expression):
    return json.loads(nix("eval", "--impure", "--json", "--expr", expression))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def archive_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path, help="Assembled release directory containing nix/ and native archives")
    parser.add_argument("--archive", type=Path, help="Override the host archive path; must match its generated checksum")
    args = parser.parse_args()
    require(shutil.which("nix"), "Nix is required for this packaging check.")
    artifacts = args.artifacts.resolve()
    flake = artifacts / "nix"
    require((flake / "package.nix").is_file(), "Assemble the release first: nix/package.nix is missing.")
    require((flake / "flake.lock").is_file(), "The release must include its pinned flake.lock.")
    require("@@" not in (flake / "package.nix").read_text(), "The generated Nix package has unresolved placeholders.")
    lock_before = (flake / "flake.lock").read_bytes()
    flake_archive = artifacts / "oa-chat-nix.tar.gz"
    require(flake_archive.is_file(), "The release must include its standalone Nix flake asset.")
    if flake_archive.is_file():
        metadata = json.loads(nix("flake", "metadata", "--json", "--no-write-lock-file", flake_archive.as_uri()))
        require(metadata["locks"] == json.loads(lock_before), "Standalone Nix archive changed the pinned flake inputs.")
        unpacked = Path(metadata["path"])
        for path in flake.iterdir():
            if path.is_file():
                require((unpacked / path.name).read_bytes() == path.read_bytes(), f"Standalone Nix archive mismatches {path.name}.")
        print("Resolved the standalone Nix tarball as a flake with unchanged inputs and package files.", flush=True)
    root = f"builtins.getFlake {nix_string('path:' + str(flake))}"
    host_system = evaluate("builtins.currentSystem")
    require(host_system in SYSTEMS, f"Unsupported validation host: {host_system}")
    packages = evaluate(f"""
      let f = {root}; in builtins.mapAttrs (_: ps: {{
        version = ps.oa-chat.version;
        url = ps.oa-chat.src.url;
        sha256 = ps.oa-chat.src.outputHash;
      }}) f.packages
    """)
    require(set(packages) == set(SYSTEMS), "Nix packages must cover exactly the four native release targets.")
    version = packages[host_system]["version"]
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version), "Invalid generated release version.")
    for system, target in SYSTEMS.items():
        manifest = packages[system]
        expected = f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{version}/oa-chat_{version}_{target}.tar.gz"
        require(manifest["version"] == version and manifest["url"] == expected, f"Unpinned/mismatched archive for {system}")
        require(re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]), f"Invalid archive digest for {system}")
        archive = artifacts / f"oa-chat_{version}_{target}.tar.gz"
        if archive.is_file():
            require(archive_digest(archive) == manifest["sha256"], f"Archive digest mismatch for {system}")
    print("Evaluated exact-tag URLs and archive hashes for all four Nix systems.", flush=True)

    modules = evaluate(f"""
      let
        f = {root};
        system = "x86_64-linux";
        pkgs = import f.inputs.nixpkgs {{ inherit system; }};
        osConfig = configDir: (f.inputs.nixpkgs.lib.nixosSystem {{
          inherit system;
          modules = [ f.nixosModules.default {{
            system.stateVersion = "26.05";
            services.oa-chat = {{ enable = true; users = [ "alice" "bob" ]; startAtLogin = true; inherit configDir; }};
          }} ];
        }}).config;
        hmConfig = configDir: (f.inputs.home-manager.lib.homeManagerConfiguration {{
          inherit pkgs;
          modules = [ f.homeManagerModules.default {{
            home.username = "alice";
            home.homeDirectory = "/home/alice";
            home.stateVersion = "26.05";
            services.oa-chat = {{ enable = true; startAtLogin = true; inherit configDir; }};
          }} ];
        }}).config;
        os = osConfig "%h/.config/oa-chat";
        hm = hmConfig "/home/alice/private state/oa-chat";
        # NixOS assertion messages may reference nonexistent data when true.
        ownFailures = config: builtins.filter (a: pkgs.lib.hasPrefix "services.oa-chat" a.message)
          (builtins.filter (a: !a.assertion) config.assertions);
      in {{
        nixos = {{
          unit = {{ inherit (os.systemd.user.services.oa-chat) unitConfig environment wantedBy serviceConfig; }};
          failures = ownFailures os;
          storeFailures = ownFailures (osConfig "/nix/store/private-wallet");
        }};
        homeManager = {{
          unit = hm.systemd.user.services.oa-chat;
          failures = ownFailures hm;
        }};
        unsafePaths = builtins.map (path: (import (f.outPath + "/service-utils.nix") {{ inherit (pkgs) lib; }}).validPrivateDir path)
          [ "/nix/store" "/nix/store/private-wallet" "/nix//store/./wallet" "/tmp/../nix/store/wallet" ];
      }}
    """)
    os_unit = modules["nixos"]["unit"]
    hm_unit = modules["homeManager"]["unit"]
    require(os_unit["unitConfig"]["ConditionUser"] == ["|alice", "|bob"], "NixOS service must restrict explicitly selected users.")
    require(os_unit["environment"]["OA_CHAT_CONFIG_DIR"] == "%h/.config/oa-chat", "NixOS config must remain per-user runtime state.")
    require(hm_unit["Service"]["Environment"] == ['"OA_CHAT_CONFIG_DIR=/home/alice/private state/oa-chat"'], "Home Manager must quote config directories containing spaces.")
    for name in ("nixos", "homeManager"):
        module = modules[name]
        require(not module["failures"], "Valid service configuration failed assertions.")
    require(modules["nixos"]["storeFailures"], "NixOS accepted private configuration in the Nix store.")
    require(not any(modules["unsafePaths"]), "Private path validation accepted the Nix store or a parent-directory traversal.")
    bad_hm = subprocess.run([
        "nix", "--extra-experimental-features", "nix-command flakes", "eval", "--impure", "--json", "--expr", f"""
          let f = {root}; in (f.inputs.home-manager.lib.homeManagerConfiguration {{
            pkgs = import f.inputs.nixpkgs {{ system = "x86_64-linux"; }};
            modules = [ f.homeManagerModules.default {{
              home.username = "alice"; home.homeDirectory = "/home/alice"; home.stateVersion = "26.05";
              services.oa-chat = {{ enable = true; configDir = "/nix/store/private-wallet"; }};
            }} ];
          }}).config.systemd.user.services.oa-chat
        """
    ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(bad_hm.returncode != 0 and "services.oa-chat.configDir" in bad_hm.stderr, "Home Manager accepted private configuration in the Nix store.")
    require(os_unit["wantedBy"] == ["default.target"] and hm_unit["Install"]["WantedBy"] == ["default.target"], "Explicit service login activation was lost.")
    require(os_unit["serviceConfig"]["UMask"] == hm_unit["Service"]["UMask"] == "0077", "User service state must stay private.")
    print("Evaluated real NixOS/Home Manager user modules, user restrictions, private-state assertions and spaced paths.", flush=True)

    archive = (args.archive.resolve() if args.archive else artifacts / f"oa-chat_{version}_{SYSTEMS[host_system]}.tar.gz")
    require(archive.is_file(), f"Host native archive is missing: {archive}")
    require(archive_digest(archive) == packages[host_system]["sha256"], "Host archive does not match generated Nix checksum.")
    expression = f"""
      let f = {root}; in f.packages.{host_system}.oa-chat.overrideAttrs (_: {{
        src = builtins.path {{ path = builtins.toPath {nix_string(archive)}; name = "oa-chat-native.tar.gz"; }};
      }})
    """
    outputs = json.loads(nix("build", "--impure", "--no-link", "--json", "--expr", expression))
    package = Path(outputs[0]["outputs"]["out"])
    with tempfile.TemporaryDirectory(prefix="oa-nix-no-state-") as temporary:
        state = Path(temporary) / "private-state"
        env = {**os.environ, "OA_CHAT_CONFIG_DIR": str(state), "PATH": str(package / "bin")}
        subprocess.run([str(package / "bin/oa-chat"), "version"], env=env, check=True)
        subprocess.run([str(package / "bin/oa-zkapi"), "--help"], env=env, check=True, stdout=subprocess.DEVNULL)
        require(not state.exists(), "Packaging smoke checks created user state.")
    for name in PROOF_FILES:
        require((package / "share/oa-chat/proof-setup" / name).stat().st_size > 0, f"Missing bundled proof asset: {name}")
    require((flake / "flake.lock").read_bytes() == lock_before, "Validation unexpectedly changed the pinned flake lock.")
    print(f"Built and executed local {host_system} release with bundled proof assets: {package}", flush=True)


if __name__ == "__main__":
    main()
