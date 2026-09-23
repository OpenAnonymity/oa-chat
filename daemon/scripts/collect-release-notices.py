#!/usr/bin/env python3
"""Preserve dependency license texts/declarations and release provenance."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

repo = Path(__file__).resolve().parents[2]
companion = Path(sys.argv[1]).resolve()
stage = Path(sys.argv[2]).resolve()
share = stage / "share/oa-chat"
notices = share / "third-party"
notices.mkdir(parents=True)

def command(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True)

def json_stream(text):
    decoder = json.JSONDecoder()
    while text.strip():
        value, end = decoder.raw_decode(text.lstrip())
        yield value
        text = text.lstrip()[end:]

records = []
def collect(name, version, directory, license_expression=None, source=None, license_file=None):
    identifier = re.sub(r"[^a-zA-Z0-9._-]", "_", name + "-" + version)
    destination = notices / identifier
    copied = []
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and re.match(r"^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)([._-]|$)", path.name, re.I):
            destination.mkdir(exist_ok=True)
            shutil.copyfile(path, destination / path.name)
            copied.append(str((destination / path.name).relative_to(share)))
    if license_file:
        path = Path(license_file)
        if not path.is_absolute():
            path = Path(directory) / path
        if path.is_file() and not (destination / path.name).exists():
            destination.mkdir(exist_ok=True)
            shutil.copyfile(path, destination / path.name)
            copied.append(str((destination / path.name).relative_to(share)))
    records.append({"name": name, "version": version, "license": license_expression,
                    "source": source, "license_files": copied})

modules = {}
for package in json_stream(command(["go", "list", "-deps", "-json", "./cmd/oa-chat"], repo / "daemon")):
    module = package.get("Module")
    if module and not module.get("Main"):
        modules[module["Path"]] = module
for name, module in sorted(modules.items()):
    collect(name, module["Version"], module["Dir"], source="https://" + name)
go_version = command(["go", "version"]).strip()
collect("Go", go_version.split()[2], command(["go", "env", "GOROOT"]).strip(), "BSD-3-Clause", "https://go.dev/")

rust_version = command(["rustc", "-vV"])
host = next(line.split(": ", 1)[1] for line in rust_version.splitlines() if line.startswith("host: "))
metadata = json.loads(command(["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", host], companion))
packages = {package["id"]: package for package in metadata["packages"]}
nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
pending = [package["id"] for package in metadata["packages"]
           if Path(package["manifest_path"]) == companion / "crates/zkapi-cli/Cargo.toml"]
visited = set()
while pending:
    identifier = pending.pop()
    if identifier in visited:
        continue
    visited.add(identifier)
    pending.extend(nodes[identifier]["dependencies"])
for identifier in sorted(visited):
    package = packages[identifier]
    collect(package["name"], package["version"], Path(package["manifest_path"]).parent,
            package.get("license"), package.get("repository") or package.get("source"), package.get("license_file"))

(notices / "dependencies.json").write_text(json.dumps(records, indent=2, sort_keys=True) + "\n")
(notices / "README.txt").write_text(
    "This directory preserves license/notice texts supplied with resolved Go and Rust build dependencies.\n"
    "dependencies.json records upstream license declarations and source references.\n"
    "The OA ZKAPI companion and protocol declare MIT OR Apache-2.0 in their Cargo manifests;\n"
    "their pinned source trees do not provide top-level license text files. Those declarations\n"
    "are retained here without assigning them the OA Chat repository's copyright notice.\n"
    "Companion source: https://github.com/OpenAnonymity/zkapi-EF-collab\n"
    "Protocol source: https://github.com/mingyech/zkapi\n"
)
build_info = {
    "oa_chat_source": "https://github.com/OpenAnonymity/oa-chat",
    "oa_chat_commit": command(["git", "rev-parse", "HEAD"], repo).strip(),
    "oa_chat_source_dirty": bool(command(["git", "status", "--porcelain"], repo).strip()),
    "companion_commit": command(["git", "rev-parse", "HEAD"], companion).strip(),
    "protocol_commit": command(["git", "rev-parse", "HEAD"], companion / "protocol").strip(),
    "companion_patch_sha256": hashlib.sha256((repo / "daemon/internal/zkapi/companion.patch").read_bytes()).hexdigest(),
    "protocol_patch_sha256": hashlib.sha256((repo / "daemon/internal/zkapi/protocol-transport.patch").read_bytes()).hexdigest(),
    "go_toolchain": go_version,
    "rust_toolchain": rust_version.strip(),
    "cargo_version": command(["cargo", "--version"]).strip(),
    "source_date_epoch": os.environ.get("SOURCE_DATE_EPOCH", "0"),
}
(share / "build-info.json").write_text(json.dumps(build_info, indent=2, sort_keys=True) + "\n")
print(f"Collected license declarations/notices for {len(records)} dependencies and build provenance")
