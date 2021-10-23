# red-cul: RED Convert UpLoad
This little utility 
- Takes one or more directories of as input
- Uses an [origin.yml](https://github.com/x1ppy/gazelle-origin) file in each input directory to find the release at RED.
- Transcodes any missing formats at RED into FLAC (for 24-bit lossess), V0 and 320.
- Creates the torrent files and uploads to RED. 

[Gazelle-origin](https://github.com/x1ppy/gazelle-origin) is currently required.

## Installing

```bash
# assuming node.js and git are installed
sudo apt install flac lame sox ffmpeg mktorrent
git clone https://github.com/lfence/red-cul 
cd red-cul
# clones flac2mp3 sub repo
git submodule update --init --recursive
# Remove unsync behavior for ancient (pre-id3) mp3 players. 
# Fixes a bug with multibyte characters in id3v23 tags.
sed -i '/use MP3::Tag;/aMP3::Tag->config(id3v23_unsync => 0);' flac2mp3/flac2mp3.pl
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
                                              [required] [default: "/home/lfen"]
  -o, --torrent-dir    Where to output torrent files
                                              [required] [default: "/home/lfen"]
  -h, --help           Show help                                       [boolean]
```

`flock.sh` is provided to avoid running multiple instances of red-cul, but queue
up jobs instead.

## Example toolchain

Have rtorrent do two things:
 - Run a `postdl.bash` script that runs `gazelle-origin` and `red-cul` (through `flock.sh`)
 - Monitor a directory for new torrents to add 

Some of this information comes from [gazelle-origin](https://github.com/x1ppy/gazelle-origin).
```
# rtorrent.rc excerpt

method.insert = cfg.basedir,  private|const|string, (cat,"/home/lfen/rtorrent/")
method.insert = cfg.watch,    private|const|string, (cat,(cfg.basedir),"watch_red/")

schedule2 = watch_directory_red, 10, 10, ((load.start_verbose, (cat, (cfg.watch), "*.torrent"), "d.delete_tied="))
method.set_key = event.download.finished,postrun,"execute2={~/postdl.bash,$d.base_path=,$d.hash=,$session.path=}"
```

The `postdl.bash` can look like so

```bash
#!/bin/bash
export RED_API_KEY=...
export ORIGIN_TRACKER=red

BASE_PATH=$1
INFO_HASH=$2
SESSION_PATH=$3

REDCUL_PATH=/some/path/red-cul/flock.sh
GAZELLEORIGIN_PATH=/some/path
TRANSCODE_DIR=/home/lfen/my_music
# NOTE this matches with .rtorrent.rc watch dir
TORRENT_DIR=/home/lfen/rtorrent/watch_red
ANNOUNCE_URL=...

if ! grep flacsfor.me "$SESSION_PATH/$INFO_HASH.torrent"; then
    # Not a RED torrent.
    exit 0
fi

$GAZELLEORIGIN_PATH -o "$BASE_PATH/origin.yaml" $INFO_HASH

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