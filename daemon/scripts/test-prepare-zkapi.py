#!/usr/bin/env python3
"""Offline preparation regression: patch-added files must pass exact-source checks."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class PreparationTests(unittest.TestCase):
    def test_added_sources_are_verified_and_unexpected_changes_rejected(self):
        with tempfile.TemporaryDirectory(prefix="oa-prepare-test-") as directory:
            root = Path(directory)
            global_config = root / "gitconfig"
            environment = dict(os.environ, GIT_CONFIG_GLOBAL=str(global_config),
                               GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="Fixture",
                               GIT_AUTHOR_EMAIL="fixture@example.invalid",
                               GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid")

            def git(path, *args):
                return subprocess.check_output(["git", "-C", str(path), *args],
                                               env=environment, stderr=subprocess.PIPE).decode().strip()

            protocol = root / "protocol-upstream"
            protocol.mkdir()
            git(protocol, "init", "-q")
            (protocol / "transport.txt").write_text("original transport\n")
            (protocol / "unchanged.txt").write_text("unchanged protocol\n")
            git(protocol, "add", ".")
            git(protocol, "commit", "-qm", "fixture protocol")
            protocol_commit = git(protocol, "rev-parse", "HEAD")

            source = root / "companion-upstream"
            source.mkdir()
            git(source, "init", "-q")
            (source / "main.txt").write_text("original companion\n")
            (source / "unchanged.txt").write_text("unchanged companion\n")
            git(source, "add", ".")
            git(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", protocol.as_uri(), "protocol")
            git(source, "commit", "-qm", "fixture companion")
            companion_commit = git(source, "rev-parse", "HEAD")

            fixture_repo = root / "oa-chat"
            scripts = fixture_repo / "daemon/scripts"
            scripts.mkdir(parents=True)
            patches = fixture_repo / "daemon/internal/zkapi"
            patches.mkdir(parents=True)
            packaging = fixture_repo / "daemon/packaging"
            packaging.mkdir()
            for name in ("prepare-zkapi.sh", "verify-zkapi-source.py"):
                shutil.copyfile(SCRIPTS / name, scripts / name)
            (packaging / "zkapi-source.env").write_text(
                f"OA_COMPANION_COMMIT={companion_commit}\nOA_PROTOCOL_COMMIT={protocol_commit}\n")
            (source / "main.txt").write_text("patched companion\n")
            (source / "withdrawal.txt").write_text("new withdrawal implementation\n")
            git(source, "add", "-N", "withdrawal.txt")
            (patches / "companion.patch").write_text(git(source, "diff", "--binary", "HEAD") + "\n")
            (protocol / "transport.txt").write_text("patched transport\n")
            (protocol / "bridge.txt").write_text("new bridge implementation\n")
            git(protocol, "add", "-N", "bridge.txt")
            (patches / "protocol-transport.patch").write_text(git(protocol, "diff", "--binary", "HEAD") + "\n")
            # Clone the fixture revisions via an isolated Git URL rewrite. There
            # are no external downloads and no changes to the user's Git config.
            global_config.write_text(
                '[protocol "file"]\n\tallow = always\n'
                f'[url "{source.as_uri()}"]\n\tinsteadOf = https://github.com/OpenAnonymity/zkapi-EF-collab.git\n')
            prepared = root / "prepared"
            result = subprocess.run(["bash", str(scripts / "prepare-zkapi.sh"), str(prepared)],
                                    env=environment, text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Verified exact companion/protocol", result.stdout)
            self.assertEqual(git(prepared, "ls-files", "--others", "--exclude-standard"), "")
            self.assertEqual(git(prepared / "protocol", "ls-files", "--others", "--exclude-standard"), "")
            self.assertEqual((prepared / "withdrawal.txt").read_text(), "new withdrawal implementation\n")
            self.assertEqual((prepared / "protocol/bridge.txt").read_text(), "new bridge implementation\n")
            self.assertEqual(git(prepared, "ls-files", "--error-unmatch", "unchanged.txt"), "unchanged.txt")
            self.assertEqual(git(prepared / "protocol", "ls-files", "--error-unmatch", "unchanged.txt"), "unchanged.txt")

            command = ["python3", str(scripts / "verify-zkapi-source.py"),
                       str(prepared), companion_commit, protocol_commit]
            for mutation in (prepared / "unexpected.txt", prepared / "protocol/bridge.txt"):
                mutation.write_text("unexpected source\n")
                rejected = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=30)
                self.assertNotEqual(rejected.returncode, 0, "unexpected source was accepted")
                if mutation.name == "unexpected.txt":
                    mutation.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
