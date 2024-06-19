#!/bin/bash
set -e
cd "$(dirname "$0")"
which curl && which tar
curl -L https://github.com/lfence/flac2mp3/archive/refs/tags/no-unsync.tar.gz | tar xzvf -
