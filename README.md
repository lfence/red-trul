# red-cul: RED Convert UpLoad
This little utility takes one or more paths to lossless releases, checks if
transcodes of FLAC (if release is 24-bit lossess), V0 and 320 exists and, if
not, transcodes into the missing formats, creates the torrent files and finally
upload them to RED. Each directory is required to contain an
[**origin.yml**](https://github.com/x1ppy/gazelle-origin) file. 

## Installing

```bash
# assuming node.js and git are installed
sudo apt install flac lame sox ffmpeg mktorrent
git clone https://github.com/lfence/red-cul 
cd red-cul
# clones flac2mp3 sub repo
git submodule update --init --recursive
npm install
```

## Usage
```
Usage: red-cul.js [OPTIONS] flac-dir [flac-dir2, [...]]

Options:
      --version        Show version number                             [boolean]
      --api-key        API token with Torrents capability. Can definable in env
                       as RED_API_KEY
  -a, --announce       Specify the full announce URL found on
                       https://redacted.ch/upload.php                 [required]
  -t, --transcode-dir  Output directory of transcodes (e.g. ~/my_music)
                                              [required] [default: "/home/jnes"]
  -o, --torrent-dir    Where to output torrent files
                                              [required] [default: "/home/jnes"]
  -h, --help           Show help                                       [boolean]
```

flock.sh is provided to avoid running multiple instances of red-cul, but queue
up jobs instead.

## Example toolchain

Have rtorrent do two things:
 - Run a postdl.bash script that runs gazelle-origin and red-cul
 - Monitor a directory for new torrents to add 

Some of this information comes from [gazelle-origin](https://github.com/x1ppy/gazelle-origin).
```
# rtorrent.rc excerpt

method.insert = cfg.basedir,  private|const|string, (cat,"/home/lfen/rtorrent/")
method.insert = cfg.watch,    private|const|string, (cat,(cfg.basedir),"watch_red/")

schedule2 = watch_directory_red, 10, 10, ((load.start_verbose, (cat, (cfg.watch), "*.torrent"), "d.delete_tied="))
method.set_key = event.download.finished,postrun,"execute2={~/postdl.bash,$d.base_path=,$d.hash=,$session.path=}"
```

The postdl.bash can look like so

```bash
#!/bin/bash
export RED_API_KEY=...
export ORIGIN_TRACKER=red

BASE_PATH=$1
INFO_HASH=$2
SESSION_PATH=$3

REDCUL_PATH=/some/path/red-cul/flock.sh
GAZELLEORIGIN_PATH=/some/path
TRANSCODE_DIR=/home/lfen/warez
TORRENT_DIR=/home/lfen/rtorrent/watch_red
ANNOUNCE_URL=...

if ! grep flacsfor.me "$SESSION_PATH/$INFO_HASH.torrent"; then
    # Not a RED torrent.
    exit 0
fi

$GAZELLEORIGIN_PATH -o "$BASE_PATH/origin.yaml" $INFO_HASH  2>&1 >> $LOG_FILE

# optional step. red-cul wont transcode anything that isn't flac
FORMAT=$(grep -Po 'Format: *\K.*' "$BASE_PATH/origin.yaml")
if ! [[ $FORMAT == "FLAC" ]]; then
  # Not a FLAC release.
  exit 0
fi

$REDCUL_PATH \
  --announce=$ANNOUNCE_URL \
  --transcode-dir=$TRANSCODE_DIR \
  --torrent-dir=$TORRENT_DIR "$BASE_PATH" &
```
