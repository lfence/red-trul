#!/bin/bash
export RED_API_KEY=...

# 0) To run this script, in qbittorrent enable "Run external program on torrent completion" 
# Set it to run "/home/USER/qbittorrent-postdl.sh" %I "%F" "%T" "%D"
# 1) Add a transcode directory (e.g., "$HOME/transcodes")
# 2) Add a torrent watch directory (e.g., "$HOME/watch_trul")
# 4) In qbittorrent settings find "Watched Folder", add the directory from 2) and have it download to the directory from 1).
cd "$(dirname "$0")" # change to same dir as this script.

# redirect stdout and stderr to logfile (the script prints nothing)
# use tail -f $LOG_FILE to watch what it says
LOG_FILE="trul.log"
exec >> $LOG_FILE
exec 2>> $LOG_FILE

INFO_HASH=$1
INPUT=$2
TRACKER=$3
TRANSCODE_DIR="$HOME/transcodes" # matches your qbit config 
TORRENT_DIR="$HOME/watch_trul" # matches your qbit config 

TRUL="flock.bash"

if ! grep -q flacsfor.me <<< $TRACKER; then
  echo not from RED. bye
  exit 0
fi

./$TRUL --info-hash=$INFO_HASH --torrent-dir="$TORRENT_DIR" \
  --transcode-dir="$TRANSCODE_DIR" "$INPUT" &
