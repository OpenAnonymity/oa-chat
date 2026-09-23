#!/usr/bin/env python3
"""Require exact pinned sources plus exactly the maintained companion patch."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("companion_commit")
parser.add_argument("protocol_commit")
args = parser.parse_args()
source = args.source.resolve()
patch_dir = Path(__file__).resolve().parents[1] / "internal/zkapi"

def git(directory, *arguments, env=None):
    return subprocess.check_output(["git", "-C", str(directory), *arguments], env=env)

for directory, expected in ((source, args.companion_commit), (source / "protocol", args.protocol_commit)):
    if git(directory, "rev-parse", "HEAD").decode().strip() != expected:
        parser.error(f"unexpected upstream revision in {directory.name}")
    if git(directory, "ls-files", "--others", "--exclude-standard").strip():
        parser.error(f"untracked source files in {directory.name}; prepare a fresh checkout")

def verify_patch(directory, patch, ignore_submodules):
    with tempfile.TemporaryDirectory(prefix="oa-zkapi-index-") as temporary:
        environment = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / "index"))
        git(directory, "read-tree", "HEAD", env=environment)
        git(directory, "apply", "--cached", str(patch), env=environment)
        expected_diff = git(directory, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", env=environment)
    actual_diff = git(directory, "diff", "--no-ext-diff", "--no-textconv", "--binary", "--ignore-submodules=" + ignore_submodules, "HEAD")
    if actual_diff != expected_diff:
        parser.error(f"{directory.name} changes differ from its maintained patch; prepare a fresh checkout")

# The parent records a protocol gitlink. Its exact HEAD was checked above;
# validate protocol working changes separately rather than hiding them in a
# generic dirty-submodule marker in the parent's diff.
verify_patch(source, patch_dir / "companion.patch", "dirty")
verify_patch(source / "protocol", patch_dir / "protocol-transport.patch", "none")
print("Verified exact companion/protocol revisions and both complete patch diffs")
