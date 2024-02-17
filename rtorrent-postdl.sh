#!/bin/bash
export RED_API_KEY=...

#
# To run this script, add to .rtorrent.rc. Modify paths to match with your configuration.
#
# schedule2 = watch_directory_red, 10, 10, ((load.start_verbose, (cat,"/home/USER/rtorrent/watch_trul/", "*.torrent"), "d.directory.set=/home/USER/transcodes", "d.delete_tied="))
# method.set_key = event.download.finished,postrun,"execute2={~/red-trul/rtorrent-postdl.sh,$d.base_path=,$d.hash=,$session.path=}"
cd "$(dirname "$0")" # change to same dir as this script.

# redirect stdout and stderr to logfile (the script prints nothing)
# use tail -f $LOG_FILE to watch what it says
LOG_FILE="trul.log"
exec >> $LOG_FILE
exec 2>> $LOG_FILE

# d.base_path
BASE_PATH=$1
# d.hash
INFO_HASH=$2
# session.path
SESSION_PATH=$3

TRUL="flock.bash"
TRANSCODE_DIR="$HOME/transcodes" # matches .rtorrent.rc
TORRENT_DIR="$HOME/rtorrent/watch_trul" # matches .rtorrent.rc

if ! grep flacsfor.me "$SESSION_PATH/$INFO_HASH.torrent"; then
    # Not a RED torrent.
    exit 0
fi

# show the following command to manually run it on error
set -x

# Run in background to unblock rtorrent. Otherwise, rtorrent hook is blocked
# until this script finishes.
./$TRUL --info-hash=$INFO_HASH --torrent-dir="$TORRENT_DIR" --transcode-dir="$TRANSCODE_DIR" "$BASE_PATH" & 
