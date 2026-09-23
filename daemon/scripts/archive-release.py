#!/usr/bin/env python3
"""Write a sorted release archive with stable ownership and timestamps."""
import gzip
import os
from pathlib import Path
import sys
import tarfile

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
with destination.open("wb") as raw:
    with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=epoch) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path in sorted(source.rglob("*")):
                info = archive.gettarinfo(str(path), arcname=str(path.relative_to(source)))
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mtime = epoch
                # Public release assets must remain readable after installation
                # even when a maintainer builds under a private shell umask.
                info.mode = 0o755 if path.is_dir() or info.mode & 0o111 else 0o644
                if path.is_file():
                    with path.open("rb") as content:
                        archive.addfile(info, content)
                else:
                    archive.addfile(info)
print(destination)
