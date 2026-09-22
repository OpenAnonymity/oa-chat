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
            names = set(archive.getnames())
            if not required.issubset(names):
                parser.error(f"{filename} is missing required release files")
            if archive.extractfile("VERSION").read().decode().strip() != args.version:
                parser.error(f"{filename} contains a mismatched version")
        values[f"{operating_system}_{architecture}_SHA256".upper()] = hashlib.sha256(path.read_bytes()).hexdigest()

for source, destination in (
    ("homebrew/oa-chat.rb.in", "homebrew/oa-chat.rb"),
    ("arch/PKGBUILD.in", "aur/PKGBUILD"),
    ("arch/.SRCINFO.in", "aur/.SRCINFO"),
):
    rendered = (repo / "daemon/packaging" / source).read_text()
    for key, value in values.items():
        rendered = rendered.replace(f"@@{key}@@", value)
    if "@@" in rendered:
        parser.error(f"unresolved template variable in {source}")
    target = artifacts / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered)

installer_source = (repo / "daemon/install.sh").read_text()
if installer_source.count("@@VERSION@@") != 1:
    parser.error("daemon/install.sh must contain exactly one release-version placeholder")
installer = artifacts / "install.sh"
installer.write_text(installer_source.replace("@@VERSION@@", args.version))
installer.chmod(0o755)

with tempfile.TemporaryDirectory(prefix="oa-chat-manifests-") as temporary:
    for directory in ("homebrew", "aur"):
        shutil.copytree(artifacts / directory, Path(temporary) / directory)
    subprocess.run([
        sys.executable, str(repo / "daemon/scripts/archive-release.py"),
        temporary, str(artifacts / "oa-chat-packaging.tar.gz"),
    ], check=True)

checksums = []
for path in sorted(artifacts.rglob("*")):
    if path.is_file() and path.name != "SHA256SUMS":
        checksums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(artifacts)}")
(artifacts / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
print(f"Generated installer, Homebrew, AUR, and SHA256SUMS files under {artifacts}")
