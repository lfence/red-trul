# red-trul: RED TRanscode-UpLoad
This little utility 
- *Conditionally* transcodes a given flac release, generates and uploads torrents.
- Requires `'Torrents'` capability from RED.
- Detects the "edition group" (e.g., "remaster" or "other media") at RED
- Transcodes FLAC16 (`"Lossless"`) and FLAC24 (`"24-bit Lossess"`) to FLAC16 (for FLAC24), `"MP3 (320)"` and `"MP3 (V0)"` --- only if there's no current item in the edition group of the particular format and/or preset.
- Generates torrent files (using `webtorrent/create-torrent`) and uploads to RED.
- API client uses `axios`. Requires token via `"Authorization:"` HTTP header.

*The tool tries to not break any rules, for example by avoiding inputs with
missing or bad tagging, but the user of this tool is liable for her own
uploads.*


## Installing

You need:
- nodejs
- flac
- lame
- sox
- ffmpeg
- git

```bash
git clone https://github.com/lfence/red-trul && cd ./red-trul
# clones flac2mp3 sub repo
git submodule update --init --recursive .
npm install
```

## Usage

```
Usage: trul.js [OPTIONS] flac-dir

Options:
      --version        Show version number                             [boolean]
  -i, --info-hash      Use the given info hash.
      --api-key        API token with 'Torrents' capability. Also environ-defined
                       as RED_API_KEY
  -o, --torrent-dir    Where to output torrent files              [default: "."]
  -a, --announce       Specify the full announce URL found on
                       https://redacted.ch/upload.php
  -t, --transcode-dir  Output directory of transcodes
      --no-v0          Don't transcode into V0                         [boolean]
      --no-320         Don't transcode into 320                        [boolean]
      --no-upload      Don't upload anything                           [boolean]
      --verbose        Print more                                      [boolean]
  -h, --help           Show help                                       [boolean]
```

### Example

```bash
./trul.js --info-hash=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
    --torrent-dir=/home/lfen/rtorrent/listen \
    '/home/lfen/Music/TNO Project - There Is No Obsession EP (Flac24)'
[-] using announce: https://flacsfor.me/f408ae911726f77c9e29ee17906ec1db/announce
[-] fetch torrent info...
[-] analyze filelist...
[-] ffprobe 6 files...
[+] Required tags are present, would transcode this
[-] permalink: https://redacted.ch/torrents.php?torrentid=4521975
[-] grouplink: https://redacted.ch/torrents.php?id=2123754
[-] fetch torrentgroup...
[-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB FLAC
[-] Transcoding 01. TNO Project - Eradicating Deviants.flac...
[-] Transcoding 02. TNO Project - Oneirology (Dance 4 Me).flac...
[-] Transcoding 03. TNO Project - Exitus Letalis.flac...
[-] Transcoding 04. TNO Project - Mendacium & Spem.flac...
[-] Transcoding 05. TNO Project - Neural Interrogation.flac...
[-] Transcoding 06. TNO Project - N05A (Who Are U).flac...
[-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB V0
>> [3140914] Using 4 transcoding processes.

[-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB 320
>> [3140942] Using 4 transcoding processes.

[-] Uploading...
[-] Write torrents...
[*] Done!
```

#### Issue with mp3 id3v2 tags and foreign (utf-16) characters

Remove unsync behavior for ancient (pre-id3) mp3 players. This fixes a bug with
special characters in tags. Some MP3 modern players would even crash because
incorrectly handling "unsynced" tags. The downside of not unsyncing is that the
ancient mp3 players may produce some "beeps" and "bops" while trying playback
tag metadata before the actual song starts. I think this is better than a modern
mp3 player in software crashes for misinterpreting the tag length...

```
sed -i '/use MP3::Tag;/aMP3::Tag->config(id3v23_unsync => 0);' flac2mp3/flac2mp3.pl
```

## Advanced: Toolchain

Use `flock.bash` to avoid running multiple instances of red-trul, but queue up
jobs instead.

red-trul is runs well non-interactively. The `rtorrent.rc` is similar
to [gazelle-origin](https://github.com/x1ppy/gazelle-origin)'s. In fact, it will
read `origin.yaml` as fallback if `--info-hash` is unspecified.

You can have rtorrent do two things:
 - Run a script `postdl.bash`, which runs `trul` (via `flock.bash`) on finished
     download.
 - Monitor a directory for new torrents that this tool generates. 


```
# rtorrent.rc

schedule2 = watch_directory_red, 10, 10, ((load.start_verbose, (cat,"/home/lfence/rtorrent/listen/", "*.torrent"), "d.delete_tied="))
method.set_key = event.download.finished,postrun,"execute2={~/postdl.bash,$d.base_path=,$d.hash=,$session.path=}"
```

The `postdl.bash` could look like this:

```bash
#!/bin/bash
# either do this, or include --api-key for ./trul.js
export RED_API_KEY=...

# d.base_path
BASE_PATH=$1
# d.hash
INFO_HASH=$2
# session.path
SESSION_PATH=$3

TRUL=/some/path/red-trul/flock.bash
TRANSCODE_DIR=/home/lfen/my_music
TORRENT_DIR=/home/lfen/rtorrent/listen

if ! grep flacsfor.me "$SESSION_PATH/$INFO_HASH.torrent"; then
    # Not a RED torrent.
    exit 0
fi

# Run in background to unblock rtorrent. Otherwise, rtorrent hook is blocked
# until this script finishes.
$TRUL --info-hash=$INFO_HASH --torrent-dir=$TORRENT_DIR "$BASE_PATH" & 
```
