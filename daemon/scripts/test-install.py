#!/usr/bin/env python3
"""Offline installer regressions. Run with: python3 daemon/scripts/test-install.py.

Uses the host's Bash, tar, and SHA-256 tools with small executable fixtures.
Platform and download stubs cover selection/failure paths, not native ABI support.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "install.sh"
PROOF_FILES = ("request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk", "manifest.json")
STUB = r'''
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

command = Path(sys.argv[0]).name
args = sys.argv[1:]
if command == "uname":
    print(os.environ["TEST_OS"] if "-s" in args or not args else os.environ["TEST_ARCH"])
elif command == "getconf":
    if os.environ.get("TEST_LIBC") == "missing":
        sys.exit(1)
    print(os.environ.get("TEST_LIBC", "glibc 2.39"))
elif command == "sw_vers":
    print(os.environ.get("TEST_MACOS", "13.0"))
elif command == "id":
    print(os.environ.get("TEST_UID", "1000"))
elif command == "sysctl":
    print(os.environ.get("TEST_TRANSLATED", "0"))
elif command == "mv":
    # Exercise the native rename utility while simulating the other OS branch.
    # BSD -h and GNU -T both replace the destination symlink itself.
    if os.environ.get("TEST_SWITCH_FAIL") == "1" and any(arg in ("-fh", "-fT") for arg in args):
        sys.exit(98)
    if sys.platform == "darwin":
        args = ["-fh" if arg == "-fT" else arg for arg in args]
    else:
        args = ["-fT" if arg == "-fh" else arg for arg in args]
    if os.environ.get("TEST_SWITCH_SIGNAL") == "1" and any(arg in ("-fh", "-fT") for arg in args):
        result = subprocess.run(["/bin/mv"] + args)
        if result.returncode == 0:
            os.kill(os.getppid(), signal.SIGTERM)
        sys.exit(result.returncode)
    os.execv("/bin/mv", ["/bin/mv"] + args)
elif command == "curl":
    urls = [arg for arg in args if arg.startswith("https://")]
    if len(urls) != 1:
        sys.exit("Expected exactly one HTTPS URL: " + repr(args))
    url = urls[0]
    match = re.fullmatch(
        r"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v"
        r"([0-9]+\.[0-9]+\.[0-9]+)/(SHA256SUMS|oa-chat_[0-9.]+_(darwin|linux)_(amd64|arm64)\.tar\.gz)",
        url,
    )
    if not match:
        sys.exit("Unexpected release URL: " + url)
    with open(os.environ["TEST_CURL_LOG"], "a") as log:
        log.write(json.dumps(args) + "\n")
    if os.environ.get("TEST_DOWNLOAD_FAIL") in (match[2], "all"):
        sys.exit(22)
    source = Path(os.environ["TEST_ARTIFACTS"]) / match[1] / match[2]
    if not source.is_file():
        sys.exit("Fixture asset not found: " + str(source))
    destination = None
    for index, arg in enumerate(args):
        if arg in ("-o", "--output"):
            destination = args[index + 1]
    if destination:
        shutil.copyfile(source, destination)
    else:
        sys.stdout.buffer.write(source.read_bytes())
else:
    with open(os.environ["TEST_FORBIDDEN_LOG"], "a") as log:
        log.write(command + " " + " ".join(args) + "\n")
    sys.exit("Installer must not invoke " + command)
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.last_result = None
        self.temporary = tempfile.TemporaryDirectory(prefix="oa-installer-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.prefix = self.home / ".local"
        self.artifacts = self.root / "artifacts"
        self.fakebin = self.root / "fakebin"
        self.fakebin.mkdir()
        self.download_temp = self.root / "temporary downloads"
        self.download_temp.mkdir()
        self.curl_log = self.root / "curl.jsonl"
        self.exec_log = self.root / "executions.log"
        self.forbidden_log = self.root / "forbidden.log"
        for command in ("curl", "uname", "getconf", "sw_vers", "id", "sysctl", "mv", "sudo",
                        "systemctl", "launchctl", "brew"):
            path = self.fakebin / command
            path.write_text("#!" + sys.executable + "\n" + STUB)
            path.chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home),
                        TMPDIR=str(self.download_temp),
                        PATH=str(self.fakebin) + os.pathsep + os.environ["PATH"],
                        TEST_OS="Linux", TEST_ARCH="x86_64",
                        TEST_ARTIFACTS=str(self.artifacts),
                        TEST_CURL_LOG=str(self.curl_log),
                        TEST_EXEC_LOG=str(self.exec_log),
                        TEST_FORBIDDEN_LOG=str(self.forbidden_log),
                        XDG_CONFIG_HOME=str(self.home / ".config"),
                        OA_CHAT_CONFIG_DIR=str(self.home / "private-config"))
        # Preserve existing wallet/configuration and shell startup files exactly.
        self.sentinels = {}
        for relative in (".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile",
                         ".config/oa-chat/config.json", ".config/oa-chat/tickets.json",
                         "Library/Application Support/oa-chat/config.json",
                         "private-config/config.json", "private-config/wallet.json"):
            path = self.home / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"installer must preserve this data\n")
            self.sentinels[path] = path.read_bytes()

    def tearDown(self):
        for path, expected in self.sentinels.items():
            self.assertEqual(path.read_bytes(), expected, str(path))
        self.assertFalse(self.forbidden_log.exists(), "Installer ran a service/package manager")
        output = self.last_result.stdout + self.last_result.stderr if self.last_result else ""
        self.assertEqual(list(self.download_temp.iterdir()), [], "Installer left temporary downloads:\n" + output)

    def fixture(self, version="1.2.3", operating_system="linux", architecture="amd64",
                missing=(), extras=(), payload_version=None, runtime_fail=None):
        directory = self.artifacts / version
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"oa-chat_{version}_{operating_system}_{architecture}.tar.gz"
        path = directory / filename
        files = {
            "VERSION": ((payload_version or version) + "\n").encode(),
            "LICENSE": b"fixture license\n",
            "CLI_PACKAGING.md": b"fixture instructions\n",
            "oa-chat.service": b"[Service]\nExecStart=/usr/bin/oa-chat serve\n",
            "share/oa-chat/build-info.json": b"{}\n",
            "share/oa-chat/third-party/dependencies.json": b"[]\n",
        }
        for name in PROOF_FILES:
            files["share/oa-chat/proof-setup/" + name] = b"fixture proof asset\n"
        for executable, argument, output in (("oa-chat", "version", "oa-chat " + version),
                                             ("oa-zkapi", "--help", "zkAPI fixture help")):
            files[executable] = (
                '#!/bin/sh\n'
                f'printf "%s\\n" "{executable} $*" >> "$TEST_EXEC_LOG"\n'
                f'[ "$#" -eq 1 ] && [ "$1" = "{argument}" ] || exit 90\n'
                + ('exit 91\n' if runtime_fail == executable else f'printf "%s\\n" "{output}"\n')
            ).encode()
        for name in missing:
            files.pop(name)
        directories = {str(parent) for name in files for parent in Path(name).parents
                       if str(parent) != "."}
        with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(directories):
                info = tarfile.TarInfo(name)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o755 if name in ("oa-chat", "oa-zkapi") else 0o644
                archive.addfile(info, io.BytesIO(data))
            for info, data in extras:
                archive.addfile(info, io.BytesIO(data) if data is not None else None)
        self.write_checksums(version)
        return path

    def write_checksums(self, version):
        directory = self.artifacts / version
        lines = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                 for path in sorted(directory.glob("*.tar.gz"))]
        (directory / "SHA256SUMS").write_text("".join(lines))

    def run_installer(self, version="1.2.3", prefix=None, arguments=(), script=None):
        command = ["/bin/bash", str(script or INSTALLER)]
        if version is not None:
            command += ["--version", version]
        if prefix is not None:
            command += ["--prefix", str(prefix)]
        self.last_result = subprocess.run(command + list(arguments), env=self.env,
                                          stdin=subprocess.DEVNULL, capture_output=True,
                                          text=True, timeout=30, cwd=self.root)
        return self.last_result

    def assert_success(self, result, version="1.2.3", prefix=None):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("unbound variable", result.stderr)
        self.assert_installed(version, prefix)

    def assert_installed(self, version="1.2.3", prefix=None):
        prefix = prefix or self.prefix
        current = prefix / "lib/oa-chat/current"
        self.assertTrue(current.is_symlink(), str(current))
        self.assertFalse((prefix / "lib/oa-chat/.install-lock").exists())
        self.assertTrue(current.resolve().is_relative_to((prefix / "lib/oa-chat/releases").resolve()))
        for executable in ("oa-chat", "oa-zkapi"):
            launcher = prefix / "bin" / executable
            self.assertTrue(launcher.is_symlink(), str(launcher))
            self.assertEqual(launcher.resolve(), current.resolve() / "bin" / executable)
            self.assertTrue(os.access(launcher, os.X_OK))
        for name in PROOF_FILES:
            self.assertTrue((current / "share/oa-chat/proof-setup" / name).is_file())
        output = subprocess.run([str(prefix / "bin/oa-chat"), "version"], env=self.env,
                                capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(output, "oa-chat " + version)

    def snapshot_install(self):
        snapshot = {}
        if self.prefix.exists():
            for path in self.prefix.rglob("*"):
                if path.is_symlink():
                    snapshot[str(path.relative_to(self.prefix))] = ("link", os.readlink(path))
                elif path.is_file():
                    snapshot[str(path.relative_to(self.prefix))] = ("file", path.read_bytes())
        return snapshot

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.prefix / "lib/oa-chat/current").exists())
        self.assertFalse((self.prefix / "bin/oa-chat").exists())
        self.assertFalse((self.prefix / "bin/oa-zkapi").exists())

    def test_all_supported_platforms_and_space_in_prefix(self):
        for operating_system, native_os in (("linux", "Linux"), ("darwin", "Darwin")):
            for architecture, native_arch in (("amd64", "x86_64"), ("arm64", "aarch64")):
                with self.subTest(platform=operating_system, architecture=architecture):
                    self.env.update(TEST_OS=native_os,
                                    TEST_ARCH="arm64" if native_os == "Darwin" and architecture == "arm64" else native_arch)
                    archive = self.fixture(operating_system=operating_system, architecture=architecture)
                    prefix = self.home / (operating_system + " " + architecture)
                    self.assert_success(self.run_installer(prefix=prefix), prefix=prefix)
                    calls = [json.loads(line) for line in self.curl_log.read_text().splitlines()]
                    self.assertTrue(any(arg.endswith("/" + archive.name) for arg in calls[-1]))

    def test_default_install_does_not_initialize_or_start_service(self):
        self.fixture()
        self.assert_success(self.run_installer())
        self.assertEqual(set(self.exec_log.read_text().splitlines()),
                         {"oa-chat version", "oa-zkapi --help"})
        self.assertFalse((self.home / ".config/systemd").exists())
        self.assertFalse((self.home / "Library/LaunchAgents").exists())
        calls = [json.loads(line) for line in self.curl_log.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        for args in calls:
            self.assertEqual(args[args.index("--proto") + 1], "=https")
            self.assertEqual(args[args.index("--proto-redir") + 1], "=https")

    def test_rosetta_downloads_native_arm64(self):
        self.env.update(TEST_OS="Darwin", TEST_ARCH="x86_64", TEST_TRANSLATED="1")
        self.fixture(operating_system="darwin", architecture="arm64")
        self.assert_success(self.run_installer())

    def test_upgrade_and_reinstall_leave_complete_active_pair(self):
        self.fixture()
        self.assert_success(self.run_installer())
        self.fixture(version="1.2.4")
        self.assert_success(self.run_installer(version="1.2.4"), version="1.2.4")
        self.assert_success(self.run_installer(version="1.2.4"), version="1.2.4")

    def test_release_script_pins_default_version(self):
        for operating_system in ("darwin", "linux"):
            for architecture in ("amd64", "arm64"):
                self.fixture(operating_system=operating_system, architecture=architecture)
        directory = self.artifacts / "1.2.3"
        result = subprocess.run([sys.executable, str(INSTALLER.parent / "scripts/assemble-release.py"),
                                 "1.2.3", str(directory)], env=self.env, capture_output=True,
                                text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        rendered = directory / "install.sh"
        self.assertNotIn("@@VERSION@@", rendered.read_text())
        self.assertTrue(os.access(rendered, os.X_OK))
        digest = hashlib.sha256(rendered.read_bytes()).hexdigest()
        self.assertIn(digest + "  install.sh", (directory / "SHA256SUMS").read_text().splitlines())
        self.assert_success(self.run_installer(version=None, script=rendered))
        self.fixture(version="1.2.4")
        self.assert_success(self.run_installer(version="1.2.4", script=rendered), version="1.2.4")

    def test_source_script_requires_explicit_version(self):
        self.assert_rejected(self.run_installer(version=None))
        self.assertFalse(self.curl_log.exists())

    def test_failed_downloads_and_checksums_preserve_previous_install(self):
        self.fixture()
        self.assert_success(self.run_installer())
        expected = self.snapshot_install()
        archive = self.fixture(version="1.2.4")
        for asset in ("SHA256SUMS", archive.name):
            with self.subTest(download=asset):
                self.env["TEST_DOWNLOAD_FAIL"] = asset
                self.assertNotEqual(self.run_installer(version="1.2.4").returncode, 0)
                self.assertEqual(self.snapshot_install(), expected)
        self.env.pop("TEST_DOWNLOAD_FAIL")
        archive.write_bytes(archive.read_bytes() + b"corrupt the checksum")
        self.assertNotEqual(self.run_installer(version="1.2.4").returncode, 0)
        self.assertEqual(self.snapshot_install(), expected)

    def test_runtime_failures_preserve_previous_install(self):
        self.fixture()
        self.assert_success(self.run_installer())
        expected = self.snapshot_install()
        for executable in ("oa-chat", "oa-zkapi"):
            with self.subTest(executable=executable):
                self.fixture(version="1.2.4", runtime_fail=executable)
                self.assertNotEqual(self.run_installer(version="1.2.4").returncode, 0)
                self.assertEqual(self.snapshot_install(), expected)

    def test_activation_failure_rolls_back_launchers_and_preserves_upgrade(self):
        self.fixture()
        self.env["TEST_SWITCH_FAIL"] = "1"
        result = self.run_installer()
        self.assert_rejected(result)
        self.assertEqual(self.snapshot_install(), {}, result.stdout + result.stderr)
        self.env.pop("TEST_SWITCH_FAIL")
        self.assert_success(self.run_installer())
        expected = self.snapshot_install()
        self.fixture(version="1.2.4")
        self.env["TEST_SWITCH_FAIL"] = "1"
        result = self.run_installer(version="1.2.4")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.snapshot_install(), expected, result.stdout + result.stderr)

    def test_signal_after_activation_keeps_complete_install(self):
        self.env["TEST_SWITCH_SIGNAL"] = "1"
        for version in ("1.2.3", "1.2.4"):
            with self.subTest(version=version):
                self.fixture(version=version)
                result = self.run_installer(version=version)
                self.assertEqual(result.returncode, 143, result.stdout + result.stderr)
                self.assert_installed(version=version)

    def test_existing_install_lock_prevents_overlapping_install(self):
        self.fixture()
        self.assert_success(self.run_installer())
        expected = self.snapshot_install()
        lock = self.prefix / "lib/oa-chat/.install-lock"
        lock.mkdir()
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(self.snapshot_install(), expected)
        self.assertTrue(lock.is_dir())

    def test_unrelated_launchers_are_preserved(self):
        self.fixture()
        (self.prefix / "bin").mkdir(parents=True)
        for kind in ("file", "symlink", "dangling-symlink"):
            with self.subTest(kind=kind):
                launcher = self.prefix / "bin/oa-chat"
                if kind == "file":
                    launcher.write_text("unrelated application")
                else:
                    target = self.root / kind
                    if kind == "symlink":
                        target.write_text("unrelated application")
                    launcher.symlink_to(target)
                expected = self.snapshot_install()
                self.assertNotEqual(self.run_installer().returncode, 0)
                self.assertEqual(self.snapshot_install(), expected)
                launcher.unlink()

    def test_malformed_archives_are_rejected_before_execution(self):
        for kind in ("traversal", "absolute", "symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                name = {"traversal": "../escaped", "absolute": str(self.root / "escaped")}.get(kind, "share/unsafe")
                info = tarfile.TarInfo(name)
                content = b"untrusted extra file"
                if kind in ("symlink", "hardlink", "fifo"):
                    info.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE,
                                 "fifo": tarfile.FIFOTYPE}[kind]
                    info.linkname = str(self.root / "escaped") if kind != "fifo" else ""
                    content = None
                else:
                    info.size = len(content)
                self.fixture(extras=[(info, content)])
                self.assert_rejected(self.run_installer())
                self.assertFalse(self.exec_log.exists(), "Unvalidated payload was executed")
                self.assertFalse((self.root / "escaped").exists())

    def test_incomplete_and_wrong_version_payloads_are_rejected(self):
        for missing in ("oa-chat", "oa-zkapi", "VERSION",
                        *("share/oa-chat/proof-setup/" + name for name in PROOF_FILES)):
            with self.subTest(missing=missing):
                self.fixture(missing=[missing])
                self.assert_rejected(self.run_installer())
        self.fixture(payload_version="9.9.9")
        self.assert_rejected(self.run_installer())
        self.assertFalse(self.exec_log.exists(), "Incomplete payload was executed")

    def test_missing_duplicate_or_invalid_checksums_are_rejected(self):
        archive = self.fixture()
        checksums = archive.parent / "SHA256SUMS"
        correct = checksums.read_text()
        for invalid in ("", correct + correct, "not-a-digest  " + archive.name + "\n"):
            with self.subTest(checksums=invalid):
                checksums.write_text(invalid)
                self.assert_rejected(self.run_installer())
        self.assertFalse(self.exec_log.exists())

    def test_unsupported_platforms_fail_before_download(self):
        for overrides in ({"TEST_OS": "FreeBSD"}, {"TEST_ARCH": "riscv64"},
                          {"TEST_LIBC": "glibc 2.38"}, {"TEST_LIBC": "musl 1.2.5"},
                          {"TEST_LIBC": "missing"},
                          {"TEST_OS": "Darwin", "TEST_MACOS": "12.7"}):
            with self.subTest(platform=overrides):
                original = self.env.copy()
                self.env.update(overrides)
                self.assert_rejected(self.run_installer())
                self.assertFalse(self.curl_log.exists())
                self.env = original

    def test_bad_arguments_fail_before_download(self):
        for options in ({"version": "../../bad"}, {"version": "latest"},
                        {"prefix": "relative/path"}, {"arguments": ("--unknown",)},
                        {"arguments": ("--prefix",)}, {"arguments": ("--version",)}):
            with self.subTest(options=options):
                self.assert_rejected(self.run_installer(**options))
                self.assertFalse(self.curl_log.exists())

    def test_root_install_is_rejected(self):
        self.env["TEST_UID"] = "0"
        self.assert_rejected(self.run_installer())
        self.assertFalse(self.curl_log.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
