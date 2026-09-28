#!/usr/bin/env python3
"""Check release package manifests and payloads without publishing anything.

Run without options for offline fixture regressions. --artifacts DIR checks an
assembled release. Add --makepkg on an Arch host to build its native package,
--homebrew to test a temporary local tap and its user service, or
--homebrew-install to test installation and a foreground server without a
service manager. Native modes require a host with no oa-chat installation.
"""

import argparse
from collections import defaultdict
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import urlopen


REPO = Path(__file__).resolve().parents[2]
PROOF_FILES = ("request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk", "manifest.json")
TARGETS = ("darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64")
ARCHITECTURES = {"x86_64": "linux_amd64", "aarch64": "linux_arm64"}
ARRAY_FIELDS = ("arch", "license", "depends", "optdepends", "options", "provides", "conflicts",
                "source_x86_64", "source_aarch64", "sha256sums_x86_64", "sha256sums_aarch64")
SCALAR_FIELDS = ("pkgname", "pkgver", "pkgrel", "pkgdesc", "url")


def check(condition, message):
    if not condition:
        raise ValueError(message)


def command(args, **kwargs):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True,
                            check=False, **kwargs)
    check(result.returncode == 0, f"Command failed: {' '.join(map(str, args))}\n"
          + result.stdout + result.stderr)
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract_archive(archive_path, destination):
    """Release archives contain public regular files/directories only."""
    with tarfile.open(archive_path, "r:gz") as archive:
        seen = set()
        for member in archive:
            path = PurePosixPath(member.name)
            check(not path.is_absolute() and ".." not in path.parts and str(path) != ".",
                  f"Unsafe archive path in {archive_path.name}: {member.name}")
            canonical = str(path)
            check(member.name == canonical or (member.isdir() and member.name == canonical + "/"),
                  f"Noncanonical archive path: {member.name}")
            check(not any(ord(character) < 32 or ord(character) == 127 for character in member.name),
                  f"Control character in archive path: {member.name!r}")
            check(canonical not in seen, f"Duplicate archive entry: {member.name}")
            seen.add(canonical)
            check(member.isfile() or member.isdir(), f"Unexpected archive link/type: {member.name}")
            check(member.mode & 0o022 == 0, f"Writable release asset: {member.name}")
            archive.extract(member, destination)


def srcinfo(text):
    result = defaultdict(list)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition(" = ")
        check(separator != "", f"Invalid .SRCINFO line: {line}")
        result[key].append(value)
    return dict(result)


def pkgbuild_metadata(path):
    # Source the project's generated PKGBUILD in a clean shell; emit unambiguous
    # NUL-delimited values, including array lengths. Do not execute package().
    script = 'source "$1"\n'
    for field in SCALAR_FIELDS:
        script += f'printf "%s\\0%s\\0" {field} "${{{field}}}"\n'
    for field in ARRAY_FIELDS:
        script += f'printf "%s\\0%s\\0" {field} "${{#{field}[@]}}"\n'
        script += f'printf "%s\\0" "${{{field}[@]}}"\n'
    values = command(["bash", "--noprofile", "--norc", "-eu", "-c", script, "metadata", path]).split("\0")
    result = {}
    index = 0
    while index < len(values) - 1:
        field, value = values[index:index + 2]
        index += 2
        if field in ARRAY_FIELDS:
            count = int(value)
            result[field] = values[index:index + count]
            index += count
        else:
            result[field] = [value]
    result["pkgbase"] = result["pkgname"]
    return result


def verify_payload(source, package):
    files = {"oa-chat": "usr/bin/oa-chat", "oa-zkapi": "usr/bin/oa-zkapi",
             "oa-chat.service": "usr/lib/systemd/user/oa-chat.service",
             "LICENSE": "usr/share/licenses/oa-chat-bin/LICENSE",
             "CLI_PACKAGING.md": "usr/share/doc/oa-chat/CLI_PACKAGING.md"}
    for path in (source / "share/oa-chat").rglob("*"):
        if path.is_file():
            files[str(path.relative_to(source))] = "usr/" + str(path.relative_to(source))
    for original, installed in files.items():
        check((package / installed).is_file(), f"Package omits {installed}")
        check(sha256(source / original) == sha256(package / installed), f"Package changed {installed}")
    for binary in ("oa-chat", "oa-zkapi"):
        check((package / "usr/bin" / binary).stat().st_mode & 0o111 != 0,
              f"Package binary is not executable: {binary}")
    # This is the companion's actual symlink-resolved lookup, not a configured
    # setup-dir override that could hide a packaging-layout error.
    proof = (package / "usr/bin/oa-zkapi").resolve().parent.parent / "share/oa-chat/proof-setup"
    for asset in PROOF_FILES:
        check((proof / asset).is_file() and (proof / asset).stat().st_size > 0,
              f"Companion cannot find proof asset {asset}")
    service = (package / "usr/lib/systemd/user/oa-chat.service").read_text()
    check("ExecStart=/usr/bin/oa-chat serve" in service, "User service runs the wrong binary")
    check("UMask=0077" in service and "WantedBy=default.target" in service,
          "Package must retain the private systemd user service")
    check(not (package / "etc").exists() and not (package / "var").exists(),
          "Package must not supply user configuration or wallet state")


def verify_artifacts(directory):
    directory = directory.resolve()
    formula = directory / "homebrew/oa-chat.rb"
    pkgbuild = directory / "aur/PKGBUILD"
    metadata = directory / "aur/.SRCINFO"
    nix_names = ("package.nix", "flake.nix", "flake.lock", "nixos-module.nix",
                 "home-manager-module.nix", "service-utils.nix", "README.md")
    nix_files = tuple(directory / "nix" / name for name in nix_names)
    for path in (formula, pkgbuild, metadata, directory / "SHA256SUMS",
                 directory / "oa-chat-nix.tar.gz", *nix_files):
        check(path.is_file(), f"Missing assembled manifest: {path}")
    for path in (formula, pkgbuild, metadata):
        check("@@" not in path.read_text(), f"Unrendered release placeholder: {path}")
    arch = pkgbuild_metadata(pkgbuild)
    check(srcinfo(metadata.read_text()) == arch, "PKGBUILD and .SRCINFO disagree")
    version = arch["pkgver"][0]
    check(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is not None, "Invalid release version")
    check(arch["pkgname"] == ["oa-chat-bin"], "Unexpected AUR package name")
    check(arch["arch"] == list(ARCHITECTURES), "AUR architecture list is incomplete")
    check("!strip" in arch["options"], "Binary package must preserve reviewed release binaries")
    check({"ca-certificates", "glibc>=2.39", "gcc-libs", "openssl>=3"}.issubset(arch["depends"]),
          "AUR package omits a native runtime dependency")
    sums = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, separator, name = line.partition("  ")
        check(separator != "" and re.fullmatch(r"[0-9a-f]{64}", digest) is not None,
              "Malformed SHA256SUMS entry")
        relative = PurePosixPath(name)
        check(not relative.is_absolute() and ".." not in relative.parts, "Unsafe checksum path")
        check(name not in sums, f"Duplicate checksum for {name}")
        sums[name] = digest
    formula_text = formula.read_text()
    base_url = f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{version}"
    pairs = re.findall(r'url "([^"\n]+)"\s+sha256 "([0-9a-f]{64})"', formula_text)
    check(len(pairs) == 4, "Homebrew formula must select all four native archives")
    check(f'  version "{version}"' in formula_text, "Homebrew version differs from AUR")
    required = {"oa-chat", "oa-zkapi", "oa-chat.service", "LICENSE", "CLI_PACKAGING.md", "VERSION",
                "share/oa-chat/build-info.json", "share/oa-chat/third-party/dependencies.json"}
    required.update("share/oa-chat/proof-setup/" + asset for asset in PROOF_FILES)
    with tempfile.TemporaryDirectory(prefix="oa-package-payloads-") as temporary:
        for target in TARGETS:
            name = f"oa-chat_{version}_{target}.tar.gz"
            archive = directory / name
            check(archive.is_file(), f"Missing native archive {name}")
            digest = sha256(archive)
            check(sums.get(name) == digest, f"SHA256SUMS mismatch for {name}")
            check((f"{base_url}/{name}", digest) in pairs, f"Homebrew URL/hash mismatch for {target}")
            source = Path(temporary) / target
            source.mkdir()
            extract_archive(archive, source)
            check(required.issubset(str(path.relative_to(source)) for path in source.rglob("*")),
                  f"Incomplete release payload for {target}")
            check((source / "VERSION").read_text().strip() == version, f"Wrong payload version: {target}")
            for asset in PROOF_FILES:
                check((source / "share/oa-chat/proof-setup" / asset).stat().st_size > 0,
                      f"Empty proof asset: {target}/{asset}")
            if target.startswith("linux_"):
                architecture = next(key for key, value in ARCHITECTURES.items() if value == target)
                check(arch[f"source_{architecture}"] == [f"{name}::{base_url}/{name}"],
                      f"AUR URL mismatch for {architecture}")
                check(arch[f"sha256sums_{architecture}"] == [digest], f"AUR checksum mismatch for {architecture}")
                package = Path(temporary) / (target + "-package")
                package.mkdir()
                if sys.platform == "darwin":
                    # BSD install accepts -D but does not create parent dirs.
                    # Native --makepkg checks GNU install's directory behavior.
                    for parent in ("usr/bin", "usr/lib/systemd/user", "usr/share/licenses/oa-chat-bin",
                                   "usr/share/doc/oa-chat"):
                        (package / parent).mkdir(parents=True, exist_ok=True)
                command(["bash", "--noprofile", "--norc", "-eu", "-c",
                         'source "$1"; srcdir="$2"; pkgdir="$3"; cd "$srcdir"; package',
                         "package", pkgbuild, source, package])
                verify_payload(source, package)
    handoff_names = ("homebrew/oa-chat.rb", "aur/PKGBUILD", "aur/.SRCINFO",
                     *("nix/" + name for name in nix_names))
    for name in (*handoff_names, "oa-chat-packaging.tar.gz", "oa-chat-nix.tar.gz"):
        check(sums.get(name) == sha256(directory / name), f"SHA256SUMS mismatch for {name}")
    with tempfile.TemporaryDirectory(prefix="oa-packaging-handoff-") as temporary:
        unpacked = Path(temporary)
        extract_archive(directory / "oa-chat-packaging.tar.gz", unpacked)
        for name in handoff_names:
            check((unpacked / name).is_file() and sha256(unpacked / name) == sha256(directory / name),
                  f"Packaging handoff archive differs from generated {name}")
    with tempfile.TemporaryDirectory(prefix="oa-nix-handoff-") as temporary:
        unpacked = Path(temporary)
        extract_archive(directory / "oa-chat-nix.tar.gz", unpacked)
        for name in nix_names:
            check((unpacked / name).is_file() and sha256(unpacked / name) == sha256(directory / "nix" / name),
                  f"Standalone Nix archive differs from generated {name}")
    command(["bash", "-n", pkgbuild])
    check(shutil.which("ruby") is not None, "Ruby is required to check Homebrew formula syntax")
    command(["ruby", "-c", formula])
    return version


def verify_makepkg(directory, version):
    check(os.geteuid() != 0, "Run makepkg as a non-root user in a disposable Arch host")
    check(shutil.which("makepkg") is not None and shutil.which("bsdtar") is not None,
          "Native Arch validation requires makepkg and bsdtar")
    with tempfile.TemporaryDirectory(prefix="oa-makepkg-") as temporary:
        root = Path(temporary)
        build = root / "build"
        build.mkdir()
        pkgbuild = build / "PKGBUILD"
        shutil.copyfile(directory / "aur/PKGBUILD", pkgbuild)
        printed = command(["makepkg", "--printsrcinfo"], cwd=build)
        check(srcinfo(printed) == srcinfo((directory / "aur/.SRCINFO").read_text()),
              "makepkg --printsrcinfo differs from the release .SRCINFO")
        # Only redirect downloads to the immutable local native archives.
        text = pkgbuild.read_text()
        for target in ("linux_amd64", "linux_arm64"):
            archive = directory / f"oa-chat_{version}_{target}.tar.gz"
            text = text.replace(f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{version}/"
                                f"oa-chat_${{pkgver}}_{target}.tar.gz", archive.as_uri())
        pkgbuild.write_text(text)
        command(["makepkg", "--nodeps", "--force", "--noconfirm"], cwd=build, timeout=120)
        archives = command(["makepkg", "--packagelist"], cwd=build).strip().splitlines()
        check(len(archives) == 1, "Expected exactly one oa-chat-bin native package")
        package = root / "installed"
        package.mkdir()
        command(["bsdtar", "-xf", archives[0], "-C", package])
        target = "linux_" + {"x86_64": "amd64", "aarch64": "arm64"}[os.uname().machine]
        source = root / "source"
        source.mkdir()
        extract_archive(directory / f"oa-chat_{version}_{target}.tar.gz", source)
        verify_payload(source, package)
        check(command([package / "usr/bin/oa-chat", "version"]).strip() == f"oa-chat {version}",
              "Installed Arch daemon version failed")
        command([package / "usr/bin/oa-zkapi", "--help"])
        service = root / "oa-chat.service"
        service.write_text((package / "usr/lib/systemd/user/oa-chat.service").read_text().replace(
            "ExecStart=/usr/bin/oa-chat serve", f'ExecStart="{package}/usr/bin/oa-chat" serve'))
        command(["systemd-analyze", "verify", service])
    print("Native makepkg payload and executable checks passed")


def verify_homebrew(directory, version, user_service=True):
    check(os.geteuid() != 0, "Run Homebrew validation as a normal user on a disposable host")
    check(shutil.which("brew") is not None, "Native Homebrew validation requires brew")
    env = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE="1", HOMEBREW_NO_INSTALL_CLEANUP="1",
               HOMEBREW_NO_ANALYTICS="1")
    installed = command(["brew", "list", "--formula", "--full-name"], env=env).splitlines()
    check(not any(name.split("/")[-1] == "oa-chat" for name in installed),
          "Refusing to replace an existing Homebrew oa-chat installation")
    with tempfile.TemporaryDirectory(prefix="oa-homebrew-") as temporary:
        root = Path(temporary)
        tap = f"oa-validation-{os.getpid()}/packages"
        formula = tap + "/oa-chat"
        repository = root / "tap"
        (repository / "Formula").mkdir(parents=True)
        text = (directory / "homebrew/oa-chat.rb").read_text()
        for target in TARGETS:
            archive = directory / f"oa-chat_{version}_{target}.tar.gz"
            text = text.replace(f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{version}/"
                                + archive.name, archive.as_uri())
        (repository / "Formula/oa-chat.rb").write_text(text)
        command(["git", "init", "-q", repository])
        command(["git", "-C", repository, "add", "Formula/oa-chat.rb"])
        command(["git", "-C", repository, "-c", "user.name=OA package validation",
                 "-c", "user.email=package-validation@localhost", "commit", "-qm", "Local package fixture"])
        # brew's entry point derives HOMEBREW_USER_CONFIG_HOME itself. Set the
        # supported XDG input so it does not reset our override to ~/.homebrew.
        env["XDG_CONFIG_HOME"] = str(root / "xdg-config")
        overrides = root / "xdg-config/homebrew/services"
        overrides.mkdir(parents=True)
        config = root / "private-config"
        (overrides / "oa-chat.env").write_text(f"OA_CHAT_CONFIG_DIR={config}\n")
        (overrides / "oa-chat.env").chmod(0o600)
        # Reserve an unused loopback port without touching the user's default.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        started = tapped = installed_here = False
        process = output = None
        log = Path(command(["brew", "--prefix"], env=env).strip()) / "var/log/oa-chat.log"
        existing_log = log.exists()
        initial_log_size = log.stat().st_size if existing_log else 0
        try:
            command(["brew", "tap", tap, repository], env=env, timeout=120)
            tapped = True
            installed_here = True
            command(["brew", "install", "--formula", formula], env=env, timeout=600)
            prefix = Path(command(["brew", "--prefix", formula], env=env).strip())
            command(["brew", "test", formula], env=env, timeout=120)
            if sys.platform.startswith("linux"):
                command(["brew", "linkage", "--test", formula], env=env, timeout=120)
            command([prefix / "bin/oa-chat", "--config-dir", config, "init", "--listen", f"127.0.0.1:{port}"], env=env)
            if user_service:
                # 'run' tests the generated service without registering it at
                # login; the temporary Homebrew env file directs private state.
                started = True
                command(["brew", "services", "run", formula], env=env, timeout=60)
            else:
                output = (root / "foreground.log").open("w")
                process = subprocess.Popen([str(prefix / "bin/oa-chat"), "--config-dir", str(config), "serve"],
                                           env=env, stdout=output, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 30
            healthy = False
            while time.monotonic() < deadline:
                try:
                    with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                        healthy = json.load(response) == {"status": "ok"}
                        if healthy:
                            break
                except (URLError, OSError):
                    pass
                time.sleep(0.2)
            if not healthy:
                diagnostics = ""
                diagnostic_log = log if user_service else root / "foreground.log"
                if diagnostic_log.is_file():
                    with diagnostic_log.open("rb") as source:
                        start = initial_log_size if user_service else 0
                        source.seek(max(start, diagnostic_log.stat().st_size - 4096))
                        diagnostics = source.read(4096).decode("utf-8", errors="replace")
                mode = "user service" if user_service else "foreground daemon"
                raise ValueError(f"Homebrew {mode} did not become healthy using isolated config\n"
                                 f"Recent operational output:\n{diagnostics}")
            check(config.stat().st_mode & 0o777 == 0o700 and
                  (config / "config.json").stat().st_mode & 0o777 == 0o600,
                  "Native service configuration permissions are not private")
            if user_service:
                command(["brew", "services", "stop", formula], env=env, timeout=60)
                started = False
            else:
                process.terminate()
                check(process.wait(timeout=10) == 0, "Homebrew foreground daemon failed shutdown")
                process = None
            deadline = time.monotonic() + 10
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        check(time.monotonic() < deadline, "Homebrew service did not stop")
                except OSError:
                    break
                time.sleep(0.2)
        finally:
            original_error = sys.exc_info()[1]
            cleanup_errors = []
            actions = []
            if process is not None:
                def stop_foreground():
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
                actions.append(stop_foreground)
            if output is not None:
                actions.append(output.close)
            if started:
                actions.append(lambda: command(["brew", "services", "stop", formula], env=env, timeout=60))
            if installed_here:
                def uninstall_owned_formula():
                    names = command(["brew", "list", "--formula", "--full-name"], env=env).splitlines()
                    if formula in names:
                        command(["brew", "uninstall", "--formula", formula], env=env, timeout=120)
                actions.append(uninstall_owned_formula)
            if tapped:
                actions.append(lambda: command(["brew", "untap", tap], env=env, timeout=60))
            if not existing_log:
                actions.append(lambda: log.unlink(missing_ok=True))
            for action in actions:
                try:
                    action()
                except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                    cleanup_errors.append(str(error))
            if cleanup_errors:
                message = (f"Validation failed: {original_error}\n" if original_error is not None else "")
                raise ValueError(message + "Native Homebrew cleanup failed:\n" + "\n".join(cleanup_errors))
    lifetime = "user service" if user_service else "foreground daemon"
    print(f"Native Homebrew install, formula test, {lifetime} health, and stop passed")


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="oa-package-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.artifacts = Path(self.temporary.name) / "artifacts"
        self.artifacts.mkdir()
        self.version = "1.2.3"
        for target in TARGETS:
            self.archive(target)
        command([sys.executable, REPO / "daemon/scripts/assemble-release.py", self.version, self.artifacts])

    def archive(self, target, missing=()):
        files = {"oa-chat": b"#!/bin/sh\nprintf 'oa-chat 1.2.3\\n'\n",
                 "oa-zkapi": b"#!/bin/sh\nprintf 'Usage: oa-zkapi\\n'\n",
                 "VERSION": b"1.2.3\n", "LICENSE": b"MIT\n", "CLI_PACKAGING.md": b"Fixture docs\n",
                 "oa-chat.service": (REPO / "daemon/packaging/systemd/oa-chat.service").read_bytes(),
                 "share/oa-chat/build-info.json": b"{}\n",
                 "share/oa-chat/third-party/dependencies.json": b"[]\n"}
        files.update({"share/oa-chat/proof-setup/" + asset: b"proof fixture\n" for asset in PROOF_FILES})
        for name in missing:
            files.pop(name)
        with tarfile.open(self.artifacts / f"oa-chat_{self.version}_{target}.tar.gz", "w:gz") as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if name in ("oa-chat", "oa-zkapi") else 0o644
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def rewrite_checksums(self):
        lines = [f"{sha256(path)}  {path.relative_to(self.artifacts)}" for path in sorted(self.artifacts.rglob("*"))
                 if path.is_file() and path.name != "SHA256SUMS"]
        (self.artifacts / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    def test_generated_manifests_and_arch_payloads(self):
        self.assertEqual(verify_artifacts(self.artifacts), self.version)

    def test_stale_srcinfo_is_rejected(self):
        path = self.artifacts / "aur/.SRCINFO"
        path.write_text(path.read_text().replace("glibc>=2.39", "glibc"))
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "PKGBUILD and .SRCINFO disagree"):
            verify_artifacts(self.artifacts)

    def test_mismatched_formula_archive_hash_is_rejected(self):
        path = self.artifacts / "homebrew/oa-chat.rb"
        path.write_text(re.sub(r'sha256 "[0-9a-f]{64}"', 'sha256 "' + "0" * 64 + '"', path.read_text(), count=1))
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Homebrew URL/hash mismatch"):
            verify_artifacts(self.artifacts)

    def test_arch_missing_proof_payload_is_rejected(self):
        path = self.artifacts / "aur/PKGBUILD"
        path.write_text(path.read_text().replace('cp -a share/oa-chat "${pkgdir}/usr/share/"', "true"))
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Package omits usr/share/oa-chat"):
            verify_artifacts(self.artifacts)

    def test_changed_binary_package_is_rejected(self):
        path = self.artifacts / "aur/PKGBUILD"
        path.write_text(path.read_text().replace('\n}', '\n    printf "changed" >> "${pkgdir}/usr/bin/oa-zkapi"\n}'))
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Package changed usr/bin/oa-zkapi"):
            verify_artifacts(self.artifacts)

    def test_missing_archive_proof_is_rejected(self):
        self.archive("linux_arm64", missing=("share/oa-chat/proof-setup/withdrawal.vk",))
        # Rehash the altered archive in both package manifests, so this exercises
        # payload validation rather than merely noticing a stale checksum.
        name = f"oa-chat_{self.version}_linux_arm64.tar.gz"
        for path in (self.artifacts / "aur/PKGBUILD", self.artifacts / "aur/.SRCINFO",
                     self.artifacts / "homebrew/oa-chat.rb"):
            text = path.read_text()
            old = next(line.split("  ")[0] for line in (self.artifacts / "SHA256SUMS").read_text().splitlines()
                       if line.endswith("  " + name))
            path.write_text(text.replace(old, sha256(self.artifacts / name)))
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Incomplete release payload for linux_arm64"):
            verify_artifacts(self.artifacts)

    def test_stale_packaging_handoff_is_rejected(self):
        path = self.artifacts / "homebrew/oa-chat.rb"
        path.write_text(path.read_text() + "\n# Updated handoff\n")
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Packaging handoff archive differs"):
            verify_artifacts(self.artifacts)

    def test_missing_standalone_nix_asset_is_rejected(self):
        (self.artifacts / "oa-chat-nix.tar.gz").unlink()
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Missing assembled manifest"):
            verify_artifacts(self.artifacts)

    def test_stale_nix_handoff_is_rejected(self):
        path = self.artifacts / "nix/package.nix"
        path.write_text(path.read_text() + "\n# Changed after assembly\n")
        self.rewrite_checksums()
        with self.assertRaisesRegex(ValueError, "Packaging handoff archive differs"):
            verify_artifacts(self.artifacts)

    def test_archive_aliases_traversal_and_links_are_rejected(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("share/./asset", tarfile.REGTYPE), ("share//asset", tarfile.REGTYPE),
                           ("share/asset", tarfile.SYMTYPE)):
            with self.subTest(name=name, kind=kind):
                path = self.artifacts / "unsafe.tar.gz"
                with tarfile.open(path, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    member.mode = 0o644
                    member.type = kind
                    member.linkname = "/outside" if kind == tarfile.SYMTYPE else ""
                    archive.addfile(member)
                with self.assertRaises(ValueError):
                    extract_archive(path, self.artifacts / "unpacked")

    def test_duplicate_directory_alias_is_rejected(self):
        path = self.artifacts / "duplicate.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name in ("share", "share/"):
                member = tarfile.TarInfo(name)
                member.mode = 0o755
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
        with self.assertRaisesRegex(ValueError, "Duplicate archive entry"):
            extract_archive(path, self.artifacts / "unpacked")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, help="Assembled release directory")
    parser.add_argument("--makepkg", action="store_true", help="Build/check native Arch package in temporary state")
    parser.add_argument("--homebrew", action="store_true", help="Install/test a temporary local tap and user service")
    parser.add_argument("--homebrew-install", action="store_true", help="Test Homebrew install and foreground server")
    args = parser.parse_args()
    if (args.makepkg or args.homebrew or args.homebrew_install) and args.artifacts is None:
        parser.error("Native package validation requires --artifacts")
    if args.homebrew and args.homebrew_install:
        parser.error("Choose either the user-service or foreground Homebrew check")
    if args.artifacts is None:
        unittest.main(argv=[sys.argv[0]])
    else:
        directory = args.artifacts.resolve()
        version = verify_artifacts(directory)
        print(f"Release {version}: manifest hashes, architectures, syntax, and Arch payloads passed")
        if args.makepkg:
            verify_makepkg(directory, version)
        if args.homebrew:
            verify_homebrew(directory, version)
        if args.homebrew_install:
            verify_homebrew(directory, version, user_service=False)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
