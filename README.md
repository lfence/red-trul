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
      --version           Show version number                          [boolean]
  -i, --info-hash         Torrent hash. Required unless an origin.yaml exists in
                           flac-dir.
      --torrent-id        Use the given torrent id. Alternative to --info-hash.
      --api-key           'Torrents'-capable API token. env-definable as RED_API
                          _KEY
  -o, --torrent-dir       Where to output torrent files           [default: "."]
  -t, --transcode-dir     Output directory of transcodes
      --no-flac           Don't transcode into FLAC                    [boolean]
      --no-v0             Don't transcode into V0                      [boolean]
      --no-320            Don't transcode into 320                     [boolean]
      --no-upload         Don't upload anything                        [boolean]
      --always-transcode  Always transcode (tags must be present)      [boolean]
  -h, --help              Show help                                    [boolean]
```

### Example

```bash
# RED_API_KEY is set in env.
# --announce=https://.../announce is optional is the 'User' capability is given.

./trul.js --info-hash=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
    --torrent-dir=/home/lfen/rtorrent/watch \
    '/home/lfen/Music/TNO Project - There Is No Obsession EP (Flac24)'
# [-] using announce: https://flacsfor.me/<redacted>/announce
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

## Advanced: post-download hook and watch directory.

This script runs well non-interactively. Post-download example scripts are
available for [qbittorrent](./qbittorrent-postdl.sh) and
[rtorrent](./rtorrent-postdl.sh). Beside configuring a post-download script for
the torrent client, also configure it to use the torrent-dir of trul as watch
dir for new torrents, and download those to the transcode dir to start seeding.


Use `flock.bash` to avoid running multiple instances of red-trul, but queue up
jobs instead.
