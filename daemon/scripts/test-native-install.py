#!/usr/bin/env python3
"""Exercise the piped installer twice with a real native archive before publication.

Only the HTTPS download is replaced with a local artifact copy. OS detection,
checksums, archive validation, executable checks, and activation use real tools.
Run as a normal user on the archive's native target; no service is started.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
args = parser.parse_args()
archive = args.archive.resolve()
match = re.fullmatch(r"oa-chat_([0-9]+\.[0-9]+\.[0-9]+)_(darwin|linux)_(amd64|arm64)\.tar\.gz", archive.name)
if not match:
    parser.error("use a versioned native release archive")
version = match[1]
installer = (Path(__file__).resolve().parents[1] / "install.sh").read_text()
if installer.count("@@VERSION@@") != 1:
    parser.error("installer release placeholder is missing or ambiguous")
installer = installer.replace("@@VERSION@@", version)

with tempfile.TemporaryDirectory(prefix="oa-native-install-") as directory:
    root = Path(directory)
    prefix = root / "prefix with spaces"
    shim = root / "download-bin"
    shim.mkdir()
    checksums = root / "SHA256SUMS"
    checksums.write_text(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
    # Do not add a localhost/file transport override to the public installer.
    curl = shim / "curl"
    curl.write_text("#!" + sys.executable + "\n" + '''
import os
from pathlib import Path
import shutil
import sys
args = sys.argv[1:]
urls = [arg for arg in args if arg.startswith("https://")]
base = os.environ["OA_NATIVE_TEST_BASE"]
files = {"SHA256SUMS": os.environ["OA_NATIVE_TEST_SUMS"],
         Path(os.environ["OA_NATIVE_TEST_ARCHIVE"]).name: os.environ["OA_NATIVE_TEST_ARCHIVE"]}
if len(urls) != 1 or urls[0] not in {base + name for name in files}:
    sys.exit("unexpected installer URL")
if args[args.index("--proto") + 1] != "=https" or args[args.index("--proto-redir") + 1] != "=https":
    sys.exit("installer transport policy changed")
shutil.copyfile(files[urls[0][len(base):]], args[args.index("--output") + 1])
''')
    curl.chmod(0o755)
    private = root / "private-config"
    private.mkdir()
    sentinel = private / "preserve.txt"
    sentinel.write_text("configuration must not change\n")
    environment = dict(os.environ,
                       PATH=str(shim) + os.pathsep + os.environ["PATH"],
                       OA_CHAT_CONFIG_DIR=str(private),
                       OA_NATIVE_TEST_ARCHIVE=str(archive),
                       OA_NATIVE_TEST_SUMS=str(checksums),
                       OA_NATIVE_TEST_BASE=f"https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v{version}/")
    for attempt in range(2):
        subprocess.run(["/bin/bash", "-s", "--", "--prefix", str(prefix)],
                       input=installer, text=True, env=environment, check=True, timeout=120)
        current = (prefix / "lib/oa-chat/current").resolve(strict=True)
        for binary in ("oa-chat", "oa-zkapi"):
            if (prefix / "bin" / binary).resolve(strict=True) != current / "bin" / binary:
                raise RuntimeError("launcher does not select the complete native bundle")
        output = subprocess.check_output([str(prefix / "bin/oa-chat"), "version"], env=environment, text=True)
        if output.strip() != f"oa-chat {version}":
            raise RuntimeError("installed version differs from archive")
        subprocess.run([str(prefix / "bin/oa-zkapi"), "--help"], env=environment,
                       stdout=subprocess.DEVNULL, check=True, timeout=30)
        for asset in ("request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk", "manifest.json"):
            if not (current / "share/oa-chat/proof-setup" / asset).stat().st_size:
                raise RuntimeError("proof asset is empty")
        if not (current / "oa-chat.service").is_file():
            raise RuntimeError("service metadata was lost")
        if sorted(path.name for path in private.iterdir()) != ["preserve.txt"] or sentinel.read_text() != "configuration must not change\n":
            raise RuntimeError("installer modified private configuration")
        if len(list((prefix / "lib/oa-chat/releases").iterdir())) != attempt + 1:
            raise RuntimeError("reinstallation did not retain the previous native bundle")
    print(f"Native piped install and reinstallation passed: {archive.name}")
