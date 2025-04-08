#!/usr/bin/env node
import REDAPIClient from "./red-api.js"
import { initConfig, getEnv } from "./config.js"
import _createTorrent from "create-torrent"
import os from "os"
import path from "path"
import yargs from "yargs"
import { execFile as _execFile } from "child_process"
import { hideBin } from "yargs/helpers"
import { promises as fs } from "fs"
import { promisify } from "util"
import debug from "debug"
const verboseLog = debug("trul:cli")

async function execFile(file, args, ops = {}) {
  verboseLog(`execFile: ${file} ${args.join(" ")}...`)
  let subprocess = null
  try {
    subprocess = _execFile(file, args, ops)
  } catch (e) {
    verboseLog(e)
    throw new Error(`[!] execFile failed: ${e.code}`)
  }
  const out = { stderr: "", stdout: "", code: NaN }

  subprocess.stderr.on("data", (d) => {
    verboseLog(`${path.basename(file)} [${subprocess.pid}]: ${d}`)
    out.stderr += d
  })
  subprocess.stdout.on("data", (d) => {
    verboseLog(`${path.basename(file)} [${subprocess.pid}]: ${d}`)
    out.stdout += d
  })
  await new Promise((res) => {
    subprocess.on("close", (code) => {
      out.code = code
      if (code !== 0) {
        verboseLog(out)
        throw new Error(`[!] execFile failed: ${code}`)
      }
      res()
    })
  })
  return out
}

const createTorrent = promisify(_createTorrent)

let { argv } = yargs(hideBin(process.argv))
  .usage("Usage: $0 [OPTIONS] flac-dir")
  .option("info-hash", {
    alias: "i",
    describe:
      "Torrent hash. Required unless an origin.yaml exists in flac-dir.",
  })
  .option("torrent-id", {
    describe: "Use the given torrent id. Alternative to --info-hash.",
  })
  .option("api-key", {
    describe: "'Torrents'-capable API token. env-definable as RED_API_KEY",
  })
  .option("torrent-dir", {
    alias: "o",
    describe: "Where to output torrent files",
    default: ".",
  })
  .option("transcode-dir", {
    alias: "t",
    describe: "Output directory of transcodes",
  })
  .option("no-flac", {
    describe: "Don't transcode into FLAC",
    boolean: true,
  })
  .option("no-v0", {
    describe: "Don't transcode into V0",
    boolean: true,
  })
  .option("no-320", {
    describe: "Don't transcode into 320",
    boolean: true,
  })
  .option("no-upload", {
    describe: "Don't upload anything",
    boolean: true,
  })
  .option("always-transcode", {
    boolean: true,
    describe: "Always transcode (if tagged correctly)",
    default: false,
  })
  .help("h")
  .alias("h", "help")

const CONFIG = initConfig(argv)
const {
  ALWAYS_TRANSCODE,
  FLAC_DIR,
  API_KEY,
  TRANSCODE_DIR,
  TORRENT_DIR,
  SOX,
  SOX_ARGS,
  FLAC2MP3,
  FLAC2MP3_ARGS,
  NO_UPLOAD,
  NO_FLAC,
  NO_V0,
  NO_320,
  SCRIPT_NAME,
  TORRENT_QUERY,
} = CONFIG
verboseLog(`${SCRIPT_NAME}! Config:`)
verboseLog(CONFIG)

if (!argv._[0]) {
  console.error(`No input, nothing to do. Try '--help'`)
  process.exit(1)
}

// API_KEY requires 'Torrents' permission.
if (!API_KEY) {
  console.error("Missing required argument '--api-key'. Try '--help' for help")
  process.exit(1)
}

const RED_ENC_FLAC24 = "24bit Lossless"
const RED_ENC_FLAC16 = "Lossless"

const RED_ENC_CBR320 = "320"
const RED_ENC_VBRV0 = "V0 (VBR)"

const LAME_ARGS = {
  [RED_ENC_VBRV0]: "-V0 -h -S",
  [RED_ENC_CBR320]: "-b 320 -h -S",
}

const DIRNAME_FORMAT = {
  [RED_ENC_FLAC16]: "FLAC16",
  [RED_ENC_VBRV0]: "V0",
  [RED_ENC_CBR320]: "320",
}
const encExists = (enc, editionGroup) =>
  editionGroup.some((torrent) => torrent.encoding === enc)

const formatPermalink = (torrent) =>
  `https://redacted.sh/torrents.php?torrentid=${torrent.id}`

const formatMessage = (torrent, command) =>
  `[b][code]transcode source:[/code][/b] [url=${formatPermalink(torrent)}][code]${torrent.format} / ${torrent.encoding}[/code][/url]
[b][code]transcode command:[/code][/b] [code]${command}[/code]
[b][code]transcode toolchain:[/code][/b] [url=https://github.com/lfence/red-trul][code]${SCRIPT_NAME}[/code][/url]`

async function ensureDir(dir) {
  try {
    await fs.access(dir)
  } catch (e) {
    throw new Error(`[!] Path "${dir}" does not exist!`)
  }
  const stats = await fs.stat(dir)
  if (!stats.isDirectory()) {
    throw new Error(`[!] "${dir}" is not a directory.`)
  }
}

const mkdirpMaybe = (() => {
  const exists = {} // remember just-created ones.
  return async function mkdirpMaybe(dir) {
    if (!exists[dir]) {
      await fs.mkdir(dir, { recursive: true })
      exists[dir] = true
    }
  }
})()

// gives an iterator<{file, dir}>. Returned filenames exclude baseDir.
async function* traverseFiles(baseDir) {
  for (let dirent of await fs.readdir(baseDir, { withFileTypes: true })) {
    const fpath = path.join(baseDir, dirent.name)
    if (dirent.isDirectory()) {
      for await (const f of traverseFiles(fpath)) {
        yield { file: f.file, dir: path.join(dirent.name, f.dir) }
      }
    }
    yield { file: dirent.name, dir: "." }
  }
}

// Copy additional (non-music) files too. Only moving png and jpegs right now,
// anything else missing?
async function copyOtherFiles(outDir, inDir, media) {
  const tasks = []
  const incFileExts = [".png", ".jpg", ".jpeg", ".pdf"]
  if (!["CD", "WEB"].includes(media)) {
    incFileExts.push(".txt") // include lineage.txt
  }
  for await (let { file, dir } of traverseFiles(inDir)) {
    if (!incFileExts.includes(path.extname(file))) {
      continue
    }
    const src = path.join(inDir, dir, file)
    const dst = path.join(outDir, dir, file)
    await mkdirpMaybe(path.join(outDir, dir))
    tasks.push(fs.copyFile(src, dst))
  }
  return Promise.all(tasks)
}

async function makeFlacTranscode(outDir, inDir, files) {
  await mkdirpMaybe(outDir)
  for (const file of files) {
    await mkdirpMaybe(path.join(outDir, path.dirname(file.path)))
    const dst = path.join(outDir, file.path)
    console.log(`[-] Transcoding ${dst}...`)
    await execFile(SOX, [
      "--multi-threaded",
      "--buffer=131072",
      ...SOX_ARGS.split(" ").map((arg) =>
        arg
          .replace("<in.flac>", path.join(inDir, file.path))
          .replace("<out.flac>", dst)
          .replace("<rate>", file.sampleRate % 48000 === 0 ? 48000 : 44100),
      ),
    ])
  }
}

async function probeMediaFile(filename) {
  const { stdout } = await execFile("ffprobe", [
    "-show_streams",
    "-show_format",
    "-print_format",
    "json",
    filename,
  ])
  return JSON.parse(stdout)
}

function filterSameEditionGroupAs({
  media,
  remasterTitle,
  remasterCatalogueNumber,
  remasterYear,
  remasterRecordLabel,
}) {
  return (t) => {
    if (t.media !== media) return false
    if (t.remasterTitle !== remasterTitle) return false
    if (t.remasterCatalogueNumber !== remasterCatalogueNumber) return false
    if (t.remasterRecordLabel !== remasterRecordLabel) return false
    if (t.remasterYear !== remasterYear) return false
    return true
  }
}

function formatArtist(group) {
  let artists = group.musicInfo.artists
  if (artists.length == 1) return artists[0].name
  else if (artists.length == 2) return `${artists[0].name} & ${artists[1].name}`
  else return "Various Artists"
}

function formatDirname(group, torrent, bitrate) {
  const format = DIRNAME_FORMAT[bitrate]
  // will make dirs for FLAC, V0 and 320 transcodes using this as base
  let dirname = `${formatArtist(group)} - ${group.name}`
  if (torrent.remasterTitle) {
    // e.g., "Special Edition"
    dirname += ` (${torrent.remasterTitle})`
  }

  const year = torrent.remasterYear || group.year
  if (year) {
    dirname += ` (${year})`
  }

  return `${dirname} [${torrent.media} ${format}]`
    .replace(/\//g, "∕") // Note that is not a normal / but a utf-8 one
    .replace(/^~/, "")
    .replace(/\.$/g, "_")
    .replace(/[\x01-\x1f]/g, "_")
    .replace(/[<>:"?*|]/g, "_")
    .trim()
}

async function analyzeFileList(inDir, fileList) {
  const flacs = fileList
    .split("|||")
    .map((e) => {
      const m = /(^.*){{{([0-9]*)}}}$/.exec(e)
      return [m[1], m[2]]
    })
    .map(([filename]) => filename)
    .filter((name) => /\.flac$/.test(name))

  console.log(`[-] Run ffprobe (${flacs.length} flacs)...`)
  const results = []
  for (const flacpath of flacs) {
    const absPath = path.join(inDir, flacpath)

    // this was originally in parallel, but for >100 files it became flaky..
    const info = await probeMediaFile(absPath)
    const tags = Object.keys(info.format.tags).map((key) => key.toUpperCase())
    if (!["TITLE", "ARTIST", "ALBUM", "TRACK"].every((t) => tags.includes(t))) {
      throw new Error(`[!] Required tags are not present! check ${absPath}`)
    }
    const flacStream = info.streams.find(
      ({ codec_name }) => codec_name === "flac",
    )

    results.push({
      path: flacpath, // e.g., CD1/01......flac
      tags,
      bitRate: Number.parseInt(flacStream.bits_per_raw_sample, 10),
      sampleRate: Number.parseInt(flacStream.sample_rate, 10),
      channels: flacStream.channels,
    })
  }

  return results
}

function shouldMakeFLAC(torrent, editionGroup, analyzedFiles) {
  if (NO_FLAC) {
    return false
  }
  if (torrent.encoding !== RED_ENC_FLAC24) {
    // we only make flac16 out of flac24
    return false
  }

  const non24Bit = analyzedFiles.filter(({ bitRate }) => bitRate !== 24)
  if (non24Bit.length !== 0) {
    console.log("[-] These are not 24bit FLACs (maybe report)")
    non24Bit.forEach((b) => console.log(`   ${b.path}: ${b.bitRate}`))
    return false
  }

  if (ALWAYS_TRANSCODE) {
    return true
  }

  // a flac16 already exists.
  return !encExists(RED_ENC_FLAC16, editionGroup)
}

async function main() {
  await fs.access(FLAC2MP3)
  await ensureDir(TRANSCODE_DIR)
  await ensureDir(TORRENT_DIR)
  await ensureDir(FLAC_DIR)

  const redAPI = new REDAPIClient(API_KEY)

  const { passkey } = await redAPI.index()
  const announce = `https://flacsfor.me/${passkey}/announce`

  console.log(`[-] Fetch torrent...`)
  // get the current torrent
  const { group, torrent } = await redAPI.torrent(TORRENT_QUERY)
  console.log(`[-] Permalink: ${formatPermalink(torrent)}`)
  if (torrent.format !== "FLAC") {
    throw new Error("[!] Not a FLAC, not interested.")
  }

  console.log(`[-] Analyze torrent.fileList...`)
  const analyzedFiles = await analyzeFileList(FLAC_DIR, torrent.fileList)

  // mp3 must not be used for anything except mono and stereo, consider AAC...
  const mp3incompatible = analyzedFiles.some((flac) => flac.channels > 2)

  console.log(`[-] Fetch torrentgroup...`)
  const { torrents } = await redAPI.torrentgroup({ id: group.id })

  // torrents that belong to this edition (how they are groups by the website)
  const editionGroup = torrents.filter(filterSameEditionGroupAs(torrent))

  if (editionGroup.length === 0) {
    throw new Error(
      "[!] Edition group should at least contain the current release",
    )
  }

  // torrents will be kept in memory before uploading, after uploading they will
  // written
  const transcodeTasks = []

  if (shouldMakeFLAC(torrent, editionGroup, analyzedFiles)) {
    const outDir = path.join(
      TRANSCODE_DIR,
      formatDirname(group, torrent, RED_ENC_FLAC16),
    )

    transcodeTasks.push({
      skipUpload: NO_UPLOAD || encExists(RED_ENC_FLAC16, editionGroup),
      outDir,
      doTranscode: () => makeFlacTranscode(outDir, FLAC_DIR, analyzedFiles),
      message: formatMessage(torrent, `sox ${SOX_ARGS}`),
      format: "FLAC",
      bitrate: RED_ENC_FLAC16,
    })
  }
  for (const bitrate of [RED_ENC_VBRV0, RED_ENC_CBR320]) {
    const skip =
      (bitrate == RED_ENC_CBR320 && NO_320) ||
      (bitrate == RED_ENC_VBRV0 && NO_V0) ||
      mp3incompatible
    const dirname = formatDirname(group, torrent, bitrate)
    const exists = encExists(bitrate, editionGroup)
    if (skip) {
      verboseLog(`Won't create ${dirname}`)
      continue
    }
    if (!ALWAYS_TRANSCODE && exists) {
      verboseLog(`${bitrate} already exists. Skip`)
      // this encoding already available. no need to transcode
      continue
    }
    const outDir = path.join(TRANSCODE_DIR, dirname)

    const args = FLAC2MP3_ARGS.split(" ").map((arg) =>
      arg
        .replace("<args>", `'${LAME_ARGS[bitrate]}'`)
        .replace("<nproc>", os.cpus().length),
    )

    transcodeTasks.push({
      outDir,
      skipUpload: NO_UPLOAD || exists,
      doTranscode: () => execFile(FLAC2MP3, [...args, FLAC_DIR, outDir]),
      message: formatMessage(torrent, `flac2mp3 ${args.join(" ")}`),
      format: "MP3",
      bitrate,
    })
  }

  const files = []
  for (const t of transcodeTasks) {
    const { outDir, doTranscode, message, format, bitrate, skipUpload } = t
    console.log(`[-] Transcoding ${outDir}`)

    await doTranscode()
    await copyOtherFiles(outDir, FLAC_DIR, torrent.media)
    const torrentBuffer = Buffer.from(
      await createTorrent(outDir, {
        private: true,
        createdBy: SCRIPT_NAME,
        announce,
        info: { source: "RED" },
      }),
    )
    if (skipUpload) continue

    files.push({
      fileName: `${path.basename(outDir)}.torrent`,
      postData: {
        format,
        bitrate,
        release_desc: message,
        file_input: torrentBuffer,
      },
    })
  }

  if (files.length === 0) {
    console.log("[-] No torrents made, nothing to upload")
    return
  }

  const uploadOpts = {
    unknown: false, // can this be true?
    scene: false,
    groupid: group.id,
    remaster_year: torrent.remasterYear,
    remaster_title: torrent.remasterTitle,
    remaster_record_label: torrent.remasterRecordLabel,
    remaster_catalogue_number: torrent.remasterCatalogueNumber,
    media: torrent.media,
    ...files[0].postData,
  }

  if (files[1]) {
    const { file_input, bitrate, format, release_desc } = files[1].postData
    uploadOpts.extra_file_1 = file_input
    uploadOpts.extra_format = [format]
    uploadOpts.extra_bitrate = [bitrate]
    uploadOpts.extra_release_desc = [release_desc]
  }

  if (files[2]) {
    const { file_input, bitrate, format, release_desc } = files[2].postData
    uploadOpts.extra_file_2 = file_input
    uploadOpts.extra_format.push(format)
    uploadOpts.extra_bitrate.push(bitrate)
    uploadOpts.extra_release_desc.push(release_desc)
  }

  // yargs does magic and inverts --no-upload..
  console.log("[-] Uploading...")
  await redAPI.upload(uploadOpts)

  files.forEach(({ fileName }) => {
    console.log(`[-] Write torrents to ${TORRENT_DIR}/${fileName}`)
  })
  await Promise.all(
    files.map(({ fileName, postData }) =>
      fs.writeFile(path.join(TORRENT_DIR, fileName), postData.file_input),
    ),
  )
  console.log("[*] Done!")
}

;(async () => {
  await main().catch((err) => {
    console.error(`${SCRIPT_NAME} failed`)
    console.error(err.message)
    verboseLog(err)
    getEnv("DEBUG") || console.error("Use 'DEBUG=trul:cli' for verbose logs")
  })
})()
