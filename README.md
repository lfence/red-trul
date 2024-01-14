# red-trul: RED TRanscode & UpLoad

`red-trul` is a lightweight utility designed to non-interactively conditionally transcode FLAC releases, generating and uploading torrents.

- Detects the edition and media (_edition group_) of a release.
- Transcodes `Lossless` and `24-bit Lossless` to `Lossless`, `MP3 (320)`, and `MP3 (V0)` when the edition group lacks the specific transcode.
- Copies image files from the original, excluding everything else.
- Maintains the original folder structure.
- Rejects releases with bad tagging or incorrect bit-rate (for 24-bit FLAC).

## API access
Requires an API key with _Torrents_ capability, created from the settings page
at RED. No further authorization is needed.

## Install

You need:
- `nodejs`
- `flac`
- `lame`
- `sox`
- `ffmpeg`
- `git`
- `perl`

```bash
git clone https://github.com/lfence/red-trul && cd ./red-trul
# clones flac2mp3 sub repo
git submodule update --init --recursive .
npm install
```

## Use

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
    --torrent-dir=/home/lfen/rtorrent/watch \
    '/home/lfen/Music/TNO Project - There Is No Obsession EP (Flac24)'
# [-] using announce: https://flacsfor.me/f408ae911726f77c9e29ee17906ec1db/announce
# [-] fetch torrent info...
# [-] analyze filelist...
# [-] ffprobe 6 files...
# [+] Required tags are present, would transcode this
# [-] permalink: https://redacted.ch/torrents.php?torrentid=4521975
# [-] grouplink: https://redacted.ch/torrents.php?id=2123754
# [-] fetch torrentgroup...
# [-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB FLAC
# [-] Transcoding 01. TNO Project - Eradicating Deviants.flac...
# [-] Transcoding 02. TNO Project - Oneirology (Dance 4 Me).flac...
# [-] Transcoding 03. TNO Project - Exitus Letalis.flac...
# [-] Transcoding 04. TNO Project - Mendacium & Spem.flac...
# [-] Transcoding 05. TNO Project - Neural Interrogation.flac...
# [-] Transcoding 06. TNO Project - N05A (Who Are U).flac...
# [-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB V0
# >> [3140914] Using 4 transcoding processes.
#
# [-] Transcoding /home/lfen/Music/TNO Project - There's No Obsession (2019) - WEB 320
# >> [3140942] Using 4 transcoding processes.
#
# [-] Uploading...
# [-] Write torrents to /home/lfen/rtorrent/watch/...
# [*] Done!
```
#### Issue with MP3 ID3v2 Tags and Foreign (UTF-16) Characters

`id3v23_unsync` behavior prevents ancient (pre-ID3) MP3 players from playing back ID3 tags that as if they were sound.
However, some ID3v2 tag decoders of modern MP3 players actually fail at undoing the unsync bytes correctly, sometimes resulting in crashes.

Therefore, disable `id3v23_unsync`, by run the following line

```bash
sed -i '/use MP3::Tag;/aMP3::Tag->config(id3v23_unsync => 0);' flac2mp3/flac2mp3.pl
# Alt.: Add `MP3::Tag->config(id3v23_unsync => 0);` right after `use MP3::Tag;`
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

schedule2 = watch_directory_red, 10, 10, ((load.start_verbose, (cat,"/home/lfen/rtorrent/listen/", "*.torrent"), "d.delete_tied="))
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
