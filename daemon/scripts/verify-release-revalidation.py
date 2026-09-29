#!/usr/bin/env python3
"""Bind packaging revalidation to an existing, successfully assembled tag build.

The source command checks GitHub run metadata and writes validated job outputs.
The artifacts command verifies every downloaded file before package execution.
Neither command builds, changes, or publishes release artifacts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile


NATIVE_JOBS = {
    "native (ubuntu-24.04, linux-amd64)",
    "native (ubuntu-24.04-arm, linux-arm64)",
    "native (macos-15-intel, darwin-amd64)",
    "native (macos-15, darwin-arm64)",
}
TARGETS = ("darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64")


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def release_version(tag):
    require(re.fullmatch(r"daemon-v[0-9]+\.[0-9]+\.[0-9]+", tag), "Invalid daemon release tag.")
    return tag.removeprefix("daemon-v")


def api(endpoint, paginate=False):
    command = ["gh", "api"] + (["--paginate", "--slurp"] if paginate else [])
    return json.loads(subprocess.check_output(command + [endpoint], text=True))


def validate_source(run, jobs, commit, tag, repository):
    require(run.get("path") == ".github/workflows/oa-daemon-release.yml", "Source run is not the daemon release workflow.")
    require(run.get("event") == "push" and run.get("head_branch") == tag, "Source run is not a push of the requested release tag.")
    require(run.get("head_sha") == commit, "Release tag no longer matches the source run commit.")
    require(run.get("repository", {}).get("full_name") == repository, "Source run belongs to another repository.")
    require(run.get("status") == "completed", "Source release run has not completed.")
    for name in NATIVE_JOBS | {"assemble"}:
        matches = [job for job in jobs if job.get("name") == name]
        require(len(matches) == 1 and matches[0].get("status") == "completed"
                and matches[0].get("conclusion") == "success", f"Required source job did not succeed: {name}")


def verify_source():
    run_id = os.environ.get("OA_SOURCE_RUN_ID", "")
    tag = os.environ.get("OA_RELEASE_TAG", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    require(re.fullmatch(r"[1-9][0-9]*", run_id), "Source run ID must be a positive integer.")
    release_version(tag)
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid source repository.")
    # The GitHub commit endpoint resolves both lightweight and annotated tags.
    commit = api(f"repos/{repository}/commits/{tag}")["sha"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid resolved release commit.")
    run = api(f"repos/{repository}/actions/runs/{run_id}")
    pages = api(f"repos/{repository}/actions/runs/{run_id}/jobs?filter=latest&per_page=100", paginate=True)
    jobs = [job for page in pages for job in page["jobs"]]
    validate_source(run, jobs, commit, tag, repository)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"commit={commit}\nsource_run_id={run_id}\nrelease_tag={tag}\n")
    print(f"Verified completed release run {run_id}: {tag} at {commit}; native matrix and assembly succeeded.")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            value.update(chunk)
    return value.hexdigest()


def verify_artifacts(root, tag, commit):
    version = release_version(tag)
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid expected release commit.")
    require(root.is_dir() and not root.is_symlink(), "Missing release artifact directory.")
    files = {}
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Release artifacts must not contain symlinks.")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = path
    require("SHA256SUMS" in files, "Missing release checksum manifest.")
    expected = {}
    for line in files["SHA256SUMS"].read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None, "Malformed release checksum entry.")
        value, name = match.groups()
        path = PurePosixPath(name)
        require(not path.is_absolute() and path.as_posix() == name
                and ".." not in path.parts and name not in expected, "Unsafe or duplicate checksum path.")
        expected[name] = value
    require(set(expected) == set(files) - {"SHA256SUMS"}, "Checksum manifest does not cover exactly the release files.")
    for name, value in expected.items():
        require(digest(files[name]) == value, f"Release checksum mismatch: {name}")
    for target in TARGETS:
        name = f"oa-chat_{version}_{target}.tar.gz"
        require(name in files, f"Missing native release archive: {name}")
        with tarfile.open(files[name], "r:gz") as archive:
            for member_name in ("VERSION", "share/oa-chat/build-info.json"):
                matches = [member for member in archive.getmembers() if member.name == member_name]
                require(len(matches) == 1 and matches[0].isfile(), f"Invalid provenance file in {name}: {member_name}")
            actual_version = archive.extractfile("VERSION").read().decode().strip()
            info = json.load(archive.extractfile("share/oa-chat/build-info.json"))
            require(actual_version == version, f"Native archive version mismatch: {name}")
            require(info.get("oa_chat_commit") == commit and info.get("oa_chat_source_dirty") is False,
                    f"Native archive does not contain clean tagged source: {name}")
    print(f"Verified every release checksum and all four clean native archives from {commit}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("source")
    artifacts = commands.add_parser("artifacts")
    artifacts.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "source":
        verify_source()
    else:
        verify_artifacts(args.directory, os.environ.get("OA_RELEASE_TAG", ""), os.environ.get("OA_RELEASE_COMMIT", ""))


if __name__ == "__main__":
    main()
