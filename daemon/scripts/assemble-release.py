#!/usr/bin/env python3
"""Render installable manifests from actual release artifacts, never placeholder hashes."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("version", help="MAJOR.MINOR.PATCH")
parser.add_argument("artifacts", type=Path, help="Directory containing all four native archives")
args = parser.parse_args()
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
    parser.error("version must be MAJOR.MINOR.PATCH")

repo = Path(__file__).resolve().parents[2]
artifacts = args.artifacts.resolve()
values = {
    "VERSION": args.version,
    "BASE_URL": f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{args.version}",
}
required = {"oa-chat", "oa-zkapi", "oa-chat.service", "LICENSE", "CLI_PACKAGING.md", "VERSION"}
required |= {"share/oa-chat/build-info.json", "share/oa-chat/third-party/dependencies.json"}
required |= {"share/oa-chat/proof-setup/" + name for name in
             ("request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk", "manifest.json")}
for operating_system in ("darwin", "linux"):
    for architecture in ("amd64", "arm64"):
        filename = f"oa-chat_{args.version}_{operating_system}_{architecture}.tar.gz"
        path = artifacts / filename
        with tarfile.open(path, "r:gz") as archive:
            members = archive.getmembers()
            names = set()
            for member in members:
                name = member.name.rstrip("/")
                if (not re.fullmatch(r"[A-Za-z0-9._/+@ -]+", name)
                        or any(part in ("", ".", "..") for part in name.split("/"))
                        or name in names or not (member.isfile() or member.isdir())):
                    parser.error(f"{filename} contains an unsafe or duplicate archive member: {member.name}")
                names.add(name)
            if not required.issubset(names):
                parser.error(f"{filename} is missing required release files")
            for name in required:
                member = archive.getmember(name)
                if not member.isfile() or member.size == 0:
                    parser.error(f"{filename} contains an empty or non-file payload: {name}")
            if archive.extractfile("VERSION").read().decode().strip() != args.version:
                parser.error(f"{filename} contains a mismatched version")
        values[f"{operating_system}_{architecture}_SHA256".upper()] = hashlib.sha256(path.read_bytes()).hexdigest()

for source, destination in (
    ("homebrew/oa-chat.rb.in", "homebrew/oa-chat.rb"),
    ("arch/PKGBUILD.in", "aur/PKGBUILD"),
    ("arch/.SRCINFO.in", "aur/.SRCINFO"),
    ("nix/package.nix.in", "nix/package.nix"),
):
    rendered = (repo / "daemon/packaging" / source).read_text()
    for key, value in values.items():
        rendered = rendered.replace(f"@@{key}@@", value)
    if "@@" in rendered:
        parser.error(f"unresolved template variable in {source}")
    target = artifacts / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered)

for source in sorted((repo / "daemon/packaging/nix").iterdir()):
    if source.is_file() and not source.name.endswith(".in"):
        shutil.copyfile(source, artifacts / "nix" / source.name)

installer_source = (repo / "daemon/install.sh").read_text()
if installer_source.count("@@VERSION@@") != 1:
    parser.error("daemon/install.sh must contain exactly one release-version placeholder")
installer = artifacts / "install.sh"
installer.write_text(installer_source.replace("@@VERSION@@", args.version))
installer.chmod(0o755)

with tempfile.TemporaryDirectory(prefix="oa-chat-manifests-") as temporary:
    for directory in ("homebrew", "aur", "nix"):
        shutil.copytree(artifacts / directory, Path(temporary) / directory)
    subprocess.run([
        sys.executable, str(repo / "daemon/scripts/archive-release.py"),
        temporary, str(artifacts / "oa-chat-packaging.tar.gz"),
    ], check=True)

# A standalone flake archive can be used directly by Nix; the combined
# packaging archive retains all three distribution handoff directories.
subprocess.run([
    sys.executable, str(repo / "daemon/scripts/archive-release.py"),
    str(artifacts / "nix"), str(artifacts / "oa-chat-nix.tar.gz"),
], check=True)

checksums = []
for path in sorted(artifacts.rglob("*")):
    if path.is_file() and path.name != "SHA256SUMS":
        checksums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(artifacts)}")
(artifacts / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
print(f"Generated installer, Homebrew, AUR, Nix, and SHA256SUMS files under {artifacts}")
