#!/usr/bin/env node
import REDAPIClient from "./red-api.js"
import YAML from "yaml"
import _createTorrent from "create-torrent"
import os from "os"
import path from "path"
import yargs from "yargs"
import { execFile as _execFile } from "child_process"
import { hideBin } from "yargs/helpers"
import { promises as fs, readFileSync, statSync, existsSync } from "fs"
import debug from "debug"
const verboseLog = debug("trul:cli")

const __dirname = path.dirname(process.argv[1])
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json")))
const createTorrent = (...args) =>
  new Promise((res, rej) =>
    _createTorrent(...args, (err, data) => (err ? rej(err) : res(data))),
  )

const { argv } = yargs(hideBin(process.argv))
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
    describe: "Always transcode (tags must be present)",
  })
  .help("h")
  .alias("h", "help")

if (!argv._[0]) {
  console.error(`No input, nothing to do. Try '--help'`)
  process.exit(1)
}

const ALWAYS_TRANSCODE = argv["always-transcode"]

const FLAC_DIR = argv._[0].replace(/\/$/, "")

// API_KEY requires 'Torrents' permission.
const API_KEY = argv["api-key"] || process.env.RED_API_KEY
if (!API_KEY) {
  console.error("Missing required argument '--api-key'. Try '--help' for help")
  process.exit(1)
}

// Here's the RED API client.
const redAPI = new REDAPIClient(API_KEY)

// Transcodes end here. If unset they end up next to the input dir
const TRANSCODE_DIR = argv["transcode-dir"] || path.dirname(FLAC_DIR)

// Ready torrents end here (rtorrent watches this dir and auto adds torrents)
const TORRENT_DIR = argv["torrent-dir"]

// Using flac2mp3 because it's great at dealing with tagging. However, it could
// just write the tags with lame and drop the perl dependency.
const FLAC2MP3_PATH = `${__dirname}/flac2mp3/flac2mp3.pl`

const formatPermalink = (torrent) =>
  `https://redacted.ch/torrents.php?torrentid=${torrent.id}`

const encExists = (enc, editionGroup) =>
  editionGroup.some((torrent) => torrent.encoding === enc)
const ENC_FLAC16 = "Lossless"
const ENC_CBR320 = "320"
const ENC_VBRV0 = "V0 (VBR)"

function getTorrentQuery() {
  if (argv["info-hash"]) {
    return { hash: argv["info-hash"] }
  }

  if (argv["torrent-id"]) {
    return { id: argv["torrent-id"] }
  }

  // if the folder has an origin.yaml file by gazelle-origin, we
  // can use that instead.
  if (existsSync(`${FLAC_DIR}/origin.yaml`)) {
    const originYaml = readFileSync(`${FLAC_DIR}/origin.yaml`)
    if (originYaml) {
      const parsed = YAML.parse(originYaml.toString("utf-8"))
      if (parsed["Format"] !== "FLAC") {
        throw new Error("[!] Not a FLAC, not interested.")
      }
      return { hash: parsed["Info hash"] }
    }
  }

  throw new Error("[!] Unable to find an info hash or id.")
}

function ensureDir(dir) {
  const stats = statSync(dir)
  if (!stats) {
    throw new Error(`[!] ${dir} does not exist!`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`[!] ${dir} is not a directory.`)
  }
}

function execFile(cmd, args) {
  return new Promise((resolve, reject) => {
    verboseLog(`execFile: ${cmd} ${args.join(" ")}`)
    const childProc = _execFile(cmd, args)
    let stdout = ""
    let stderr = ""
    childProc.stdout.on("data", (d) => {
      stdout += d
      verboseLog(`[${childProc.pid}] ${d}`)
    })
    childProc.stderr.on("data", (d) => {
      stderr += d
      verboseLog(`[${childProc.pid}] ${d}`)
    })
    childProc.on("exit", (code) => {
      if (code !== 0) {
        reject({ stdout, stderr })
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
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
        yield { file: f, dir: path.join(f.dir, dirent.name) }
      }
    }
    yield { file: dirent.name, dir: "." }
  }
}

// Copy additional (non-music) files too. Only moving png and jpegs right now,
// anything else missing?
async function copyOtherFiles(outDir, inDir) {
  const tasks = []
  for await (let { file, dir } of traverseFiles(inDir)) {
    if (!/\.(png|jpe?g)$/.test(file)) continue
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
    const src = path.join(inDir, file.path)
    const dst = path.join(outDir, file.path)
    console.log(`[-] Transcoding ${dst}...`)

    const sampleRate = file.sampleRate % 48000 === 0 ? 48000 : 44100

    await execFile("sox", [
      "--multi-threaded",
      "--buffer=131072",
      "-G",
      src,
      "-b16",
      dst,
      "rate",
      "-v",
      "-L",
      `${sampleRate}`,
      "dither",
    ])
  }
}

async function probeMediaFile(path) {
  const { stdout } = await execFile("ffprobe", [
    "-v",
    "quiet",
    "-show_streams",
    "-show_format",
    "-print_format",
    "json",
    path,
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

const sanitizeFilename = (filename) =>
  filename
    .replace(/\//g, "∕") // Note that is not a normal / but a utf-8 one
    .replace(/^~/, "")
    .replace(/\.$/g, "_")
    .replace(/[\x01-\x1f]/g, "_")
    .replace(/[<>:"?*|]/g, "_")
    .trim()

function formatDirname(group, torrent, format) {
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

  return sanitizeFilename(`${dirname} [${torrent.media} ${format}]`)
}

function formatMessage(torrent, command) {
  return `[b][code]transcode source:[/code][/b] [url=${formatPermalink(torrent)}][code]${torrent.format} / ${torrent.encoding}[/code][/url]
[b][code]transcode command:[/code][/b] [code]${command}[/code]
[b][code]transcode toolchain:[/code][/b] [url=https://github.com/lfence/red-trul][code]${pkg.name}@${pkg.version}[/code][/url]`
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
  for (const path of flacs) {
    const absPath = `${inDir}/${path}`

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
      path, // e.g., CD1/01......flac
      tags,
      bitRate: Number.parseInt(flacStream.bits_per_raw_sample, 10),
      sampleRate: Number.parseInt(flacStream.sample_rate, 10),
    })
  }

  return results
}

function shouldMakeFLAC(torrent, editionGroup, analyzedFiles) {
  if (argv["flac"] === false) {
    return false
  }
  if (torrent.encoding !== "24bit Lossless") {
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
  return !encExists(ENC_FLAC16, editionGroup)
}

async function main(inDir) {
  statSync(FLAC2MP3_PATH)
  ensureDir(TRANSCODE_DIR)
  ensureDir(TORRENT_DIR)

  const { passkey } = await redAPI.index()
  const announce = `https://flacsfor.me/${passkey}/announce`
  const torrentQuery = getTorrentQuery()

  console.log(`[-] Fetch torrent...`)
  // get the current torrent
  const { group, torrent } = await redAPI.torrent(torrentQuery)

  console.log(`[-] Analyze torrent.fileList...`)
  const analyzedFiles = await analyzeFileList(inDir, torrent.fileList)
  // if that didn't throw, tags should be OK.
  console.log("[*] Required tags are present, would transcode this!")

  console.log(`[-] Permalink: ${formatPermalink(torrent)}`)

  // see what releases already exists for you.
  console.log(`[-] Fetch torrentgroup...`)
  const { torrents } = await redAPI.torrentgroup({ id: group.id })

  // torrents that belong to this edition (how they are groups by the website)
  const editionGroup = torrents.filter(filterSameEditionGroupAs(torrent))

  if (editionGroup.length === 0) {
    throw Error("[!] Edition group should at least contain the current release")
  }

  // torrents will be kept in memory before uploading, after uploading they will
  // written
  const transcodeTasks = []

  if (shouldMakeFLAC(torrent, editionGroup, analyzedFiles)) {
    const outDir = path.join(
      TRANSCODE_DIR,
      formatDirname(group, torrent, "FLAC16"),
    )
    transcodeTasks.push({
      skipUpload:
        argv["upload"] === false || encExists(ENC_FLAC16, editionGroup),
      outDir,
      doTranscode: () => makeFlacTranscode(outDir, inDir, analyzedFiles),
      message: formatMessage(
        torrent,
        `sox -G <in.flac> -b16 <out.flac> rate -v -L <rate> dither`,
      ),
      format: "FLAC",
      bitrate: "Lossless",
    })
  }

  for (const [skip, encoding, args, dirname] of [
    [
      argv["v0"] === false,
      ENC_VBRV0,
      "-V 0 -h -S",
      formatDirname(group, torrent, "V0"),
    ],
    [
      argv["320"] === false,
      ENC_CBR320,
      "-b 320 -h -S",
      formatDirname(group, torrent, "320"),
    ],
  ]) {
    const exists = encExists(encoding, editionGroup)
    if (skip) {
      verboseLog(`Won't create ${dirname}`)
      continue
    }
    if (!ALWAYS_TRANSCODE && exists) {
      verboseLog(`${encoding} already exists. Skip`)
      // this encoding already available. no need to transcode
      continue
    }
    const outDir = path.join(TRANSCODE_DIR, dirname)
    transcodeTasks.push({
      outDir,
      skipUpload: argv["upload"] === false || exists,
      doTranscode: () =>
        execFile(FLAC2MP3_PATH, [
          "--quiet",
          `--lameargs=${args}`,
          `--processes=${os.cpus().length}`,
          inDir,
          outDir,
        ]),
      message: formatMessage(torrent, `flac2mp3 --lameargs="${args}"`),
      format: "MP3",
      bitrate: encoding,
    })
  }

  const files = []
  for (const t of transcodeTasks) {
    const { outDir, doTranscode, message, format, bitrate, skipUpload } = t
    console.log(`[-] Transcoding ${outDir}`)
    await doTranscode()
    await copyOtherFiles(outDir, inDir)
    const torrentBuffer = await createTorrent(outDir, {
      private: true,
      createdBy: `${pkg.name}@${pkg.version}`,
      announce,
      info: { source: "RED" },
    })
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
    console.log("[-] No files made, nothing to do")
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
  await main(FLAC_DIR).catch((...err) => {
    console.error(`${pkg.name}@${pkg.version} failed`)
    console.error(...err)
  })
})()
