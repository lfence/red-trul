#!/usr/bin/env node
const axios = require("axios").default
const yaml = require("yaml")
const q = require("querystring")
const fs = require("fs")
const path = require("path")
const os = require("os")
const _execFile = require("child_process").execFile
const pkg = require("./package.json")
const BIN_PATH = `${process.env.HOME}/.local/bin`
const FormData = require("form-data")
const yargs = require("yargs")

const argv = yargs
  .usage("Usage: $0 [OPTIONS] flac-dir [flac-dir2, [...]]")
  .option("api-key", {
    describe:
      "API token with Torrents capability. Env definable as RED_API_KEY",
  })
  .option("torrent-dir", {
    alias: "o",
    describe: "Where to output torrent files",
    default: ".",
  })
  .option("announce", {
    alias: "a",
    describe:
      "Specify the full announce URL found on https://redacted.ch/upload.php",
  })
  .option("transcode-dir", {
    alias: "t",
    describe: "Output directory of transcodes",
  })
  .option("no-v0", {
    describe: "Don't transcode into V0",
    boolean: true,
  })
  .option("no-320", {
    describe: "Don't transcode into 320",
    boolean: true,
  })
  .option("verbose", {
    boolean: true,
    describe: "Print more",
  })
  .help("h")
  .alias("h", "help").argv

const VERBOSE = argv["verbose"]

// supported presets <encoding,flac2mp3_preset>
const MP3_PRESETS = {
  "V0 (VBR)": "V0",
  320: "320",
}

if (argv["no-v0"]) {
  if (VERBOSE) {
    console.log("[-] Won't transcode V0")
  }
  delete MP3_PRESETS["V0 (VBR)"]
}

if (argv["no-320"]) {
  if (VERBOSE) {
    console.log("[-] Won't transcode 320")
  }
  delete MP3_PRESETS["320"]
}

const nproc = os.cpus().length

const RED_API = process.env.RED_API || "https://redacted.ch/ajax.php"

// API_KEY requires 'Torrents' permission.
const API_KEY = argv["api-key"] || process.env.RED_API_KEY
if (!API_KEY) {
  console.error("Missing required argument '--api-key'")
  process.exit(1)
}

// Will set it if unset
let ANNOUNCE_URL = argv["announce"]

// Transcodes end here. If unset they end up next to the input dir
const TRANSCODE_DIR = argv["transcode-dir"]
if (TRANSCODE_DIR && !fs.statSync(TRANSCODE_DIR, { throwIfNoEntry: false })) {
  console.error(`${TRANSCODE_DIR} does not exist! Please create it.`)
  process.exit(1)
}

// Ready torrents end here (rtorrent watches this dir and auto adds torrents)
const TORRENT_DIR = argv["torrent-dir"]
if (!fs.statSync(TORRENT_DIR, { throwIfNoEntry: false })) {
  console.error(`${TORRENT_DIR} does not exist! Please create it.`)
  process.exit(1)
}

const FLAC2MP3_PATH =
  process.env.FLAC2MP3 || `${__dirname}/flac2mp3/flac2mp3.pl`

const HTTP_AUTHZ_HEADERS = {
  Authorization: API_KEY,
  "user-agent": `${pkg.name}@${pkg.version}`,
}

const sanitizeFilename = (filename) =>
  filename
    .replace(/\//g, "∕")
    .replace(/^~/, "")
    .replace(/\.$/g, "_")
    .replace(/[\x01-\x1f]/g, "_")
    .replace(/[<>:"?*|]/g, "_")
    .trim()

function execFile(cmd, args, mute) {
  return new Promise((resolve, reject) => {
    if (VERBOSE) {
      console.log(`[-] execFile: ${cmd} ${args.join(" ")}`)
    }
    const childProc = _execFile(cmd, args)
    const prefix = `>> [${childProc.pid}] `
    const prefixErr = `!! [${childProc.pid}] `
    let stdout = ""
    let stderr = ""
    childProc.stdout.on("data", (d) => {
      stdout += d
      if (mute) return
      process.stdout.write(prefix + d)
    })
    childProc.stderr.on("data", (d) => {
      stderr += d
      if (!VERBOSE) return
      process.stderr.write(prefixErr + d)
    })
    childProc.on("exit", (code) => {
      if (code !== 0) {
        console.error(`cmd failed: ${cmd} ${args.join(" ")}`)
        reject({ stdout, stderr })
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// Copy additional (non-music) files too. Only moving png and jpegs right now,
// anything else missing?
async function copyOtherFiles(inDir, outDir) {
  const files = await fs.promises.readdir(inDir)
  for (const file of files) {
    // if its not flac or mp3, check if its a directory and do the same thing in
    // the directory e.g., ./CD1/...
    if (!/\.(flac|mp3)$/.test(file)) {
      const stats = await fs.promises.lstat(`${inDir}/${file}`)
      if (stats.isDirectory()) {
        await copyOtherFiles(`${inDir}/${file}`, `${outDir}/${file}`)
      }
    }
  }
  return Promise.all(
    files
      .filter((f) => /\.(jpe?g|png)$/.test(f))
      .map((file) =>
        fs.promises.copyFile(`${inDir}/${file}`, `${outDir}/${file}`)
      )
  )
}

async function makeFlacTranscode(outDir, inDir, sampleRate) {
  console.log(`[-] FLAC transcode ${inDir} -> ${outDir}`)
  try {
    await fs.promises.mkdir(outDir)
  } catch (err) {
    if (err.code !== "EEXIST") {
      // output directory must not exist already. there's a risk, if transcoding
      // flac24->flac16 that the folder have the same name.
      throw err
    }
  }
  const files = await fs.promises.readdir(inDir)

  for (const file of files) {
    if (!/\.flac$/.test(file)) {
      const stats = await fs.promises.lstat(`${inDir}/${file}`)
      if (stats.isDirectory()) {
        // recurse into next subdirectory.
        await makeFlacTranscode(
          `${outDir}/${file}`,
          `${inDir}/${file}`,
          sampleRate
        )
      }
    } else {
      console.log(`[-] Transcoding ${file}...`)
      await execFile("sox", [
        "--multi-threaded",
        "--buffer=131072",
        "-G",
        `${inDir}/${file}`,
        "-b16",
        `${outDir}/${file}`,
        "rate",
        "-v",
        "-L",
        `${sampleRate}`,
        "dither",
      ])
    }
  }
  await copyOtherFiles(inDir, outDir)
  return {
    method: `sox -G input.flac -b16 output.flac rate -v -L ${sampleRate} dither`,
    outDir,
    format: "FLAC",
    bitrate: "Lossless",
  }
}

async function makeMp3Transcode(outDir, inDir, bitrate) {
  const preset = MP3_PRESETS[bitrate]
  console.log("[-] Transcoding", preset)

  await execFile(FLAC2MP3_PATH, [
    `--preset=${preset}`,
    `--processes=${nproc}`,
    inDir,
    outDir,
  ])
  await copyOtherFiles(inDir, outDir)
  return {
    method: `flac2mp3 --preset=${preset}`,
    outDir,
    format: "MP3",
    bitrate,
  }
}

async function probeMediaFile(path) {
  const { stdout } = await execFile(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-show_streams",
      "-show_format",
      "-print_format",
      "json",
      path,
    ],
    true
  )
  return JSON.parse(stdout)
}

function getBitrate(probeInfo) {
  const flacStream = probeInfo.streams.find(
    ({ codec_name }) => codec_name === "flac"
  )
  return Number.parseInt(flacStream.bits_per_raw_sample, 10)
}

async function index() {
  const resp = await axios.get(`${RED_API}?action=index`, {
    headers: HTTP_AUTHZ_HEADERS,
  })

  if (resp.data.status !== "success") {
    throw new Error(`index: ${resp.data.status}`)
  }

  return resp.data.response
}

async function torrentgroup({ hash }) {
  const resp = await axios.get(
    `${RED_API}?${q.encode({
      action: "torrentgroup",
      hash,
    })}`,
    {
      validateStatus: (status) => status < 500,
      headers: HTTP_AUTHZ_HEADERS,
    }
  )

  if (resp.data.status !== "success") {
    throw new Error(`getTorrentGroup: ${resp.data.status}`)
  }

  return resp.data.response
}

async function upload(opts) {
  const form = new FormData()

  for (const [k, v] of Object.entries(opts)) {
    if (v) {
      if (Array.isArray(v)) {
        for (const el of v) {
          form.append(`${k}[]`, el)
        }
      } else {
        form.append(k, v)
      }
    }
  }

  if (VERBOSE) {
    const { extra_file_1, extra_file_2, file_input, ...rest } = opts
    console.log(rest)
  }

  const resp = await axios.post(`${RED_API}?action=upload`, form, {
    headers: {
      ...HTTP_AUTHZ_HEADERS,
      ...form.getHeaders(),
    },
  })

  if (resp.data.status !== "success") {
    throw new Error(`getTorrentGroup: ${resp.data.status}`)
  }

  return resp.data.response
}

const filterSameEditionGroupAs = ({
  media,
  remasterTitle,
  remasterCatalogueNumber,
  remasterYear,
  remasterRecordLabel,
}) =>
  function filterSameEdition(torrent) {
    // if nothing else given, all torrents are included in the editionGroup
    let result = true

    // if not same media, be gone!
    result &= torrent.media === media

    if (remasterTitle) {
      // for the rest, just filter if available
      result &= torrent.remasterTitle === remasterTitle
    }
    if (remasterCatalogueNumber) {
      result &= torrent.remasterCatalogueNumber === remasterCatalogueNumber
    }
    if (remasterRecordLabel) {
      result &= torrent.remasterRecordLabel === remasterRecordLabel
    }
    if (remasterYear) {
      result &= torrent.remasterYear === remasterYear
    }
    return result
  }

const toCamelCase = (str) =>
  str
    .split(" ")
    .map((word) => word.toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join("")
    .replace(/^./, (c) => c.toLowerCase())

async function getOrigin(originPath) {
  const origin = await fs.promises.readFile(originPath)
  const parsed = yaml.parse(origin.toString("utf-8"))

  // parse and transform object keys, eg. o["Edition Year"] -> o.editionYear
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [toCamelCase(k), v])
  )
}

// get the sample rate of this release or return false if the sample rates are
// bad (inconsistent or too low)
function getConsistentSampleRate(probeInfos) {
  let currentRate = null
  for (const probeInfo of probeInfos) {
    const flacStream = probeInfo.streams.find(
      ({ codec_name }) => codec_name === "flac"
    )
    const srcSampleRate = Number.parseInt(flacStream.sample_rate, 10)
    if (!currentRate) {
      currentRate = srcSampleRate
    } else if (currentRate !== srcSampleRate) {
      console.warn(
        `Inconsistent sample rates, ${currentRate} vs ${srcSampleRate}`
      )
      return false
    } else if (srcSampleRate < 44100) {
      console.warn(`Sample rates below minimum, ${srcSampleRate}`)
      return false
    }
  }
  return currentRate
}

function requiredTagsPresent(probeInfos) {
  return probeInfos.some((pi) => {
    // ffprobe bad. tags are lowercased at random.
    const tags = Object.keys(pi.format.tags).map((key) => key.toUpperCase())
    return ["TITLE", "ARTIST", "ALBUM", "TRACK"].every((t) => tags.includes(t))
  })
}

async function computeTargetSize(basePath) {
  const paths = [basePath]
  let total = 0
  while (paths.length > 0) {
    const p = paths.pop()
    const stats = await fs.promises.lstat(p)
    total += stats.size

    if (stats.isDirectory()) {
      const fnames = await fs.promises.readdir(p)
      paths.push(...fnames.map((f) => path.join(p, f)))
    }
  }
  return total
}

async function mktorrent(targetDir, torrentPath) {
  const sz = await computeTargetSize(targetDir)
  // a torrent should have around 1000-1500 pieces.
  const pieceLength = Math.max(
    15,
    Math.min(28, Math.round(Math.log2(sz >> 10)))
  )
  return execFile(`mktorrent`, [
    `--piece-length=${pieceLength}`,
    "--private",
    "--source=RED",
    `--announce=${ANNOUNCE_URL}`,
    targetDir,
    `--output=${torrentPath}`,
  ])
}

async function main(inputDir) {
  const origin = await getOrigin(`${inputDir}/origin.yaml`)

  if (origin.format !== "FLAC") {
    console.log("[-] Not a flac, not interested")
    return
  }

  if (!ANNOUNCE_URL) {
    ANNOUNCE_URL = await (async () => {
      try {
        const { passkey } = await index()
        return `https://flacsfor.me/${passkey}/announce`
      } catch (e) {
        console.error(`Can't GET ?action=index: ${e.message}`)
        process.exit(1)
      }
    })()
  }

  const torrentGroup = await torrentgroup({ hash: origin.infoHash })

  const editionInfo = {
    media: origin.media,
    remasterTitle: origin.edition,
    remasterCatalogueNumber: origin.catalogNumber,
    remasterYear: origin.editionYear || origin.originalYear,
    remasterRecordLabel: origin.recordLabel,
  }
  console.log("[-] permalink:", origin.permalink)

  const editionGroup = torrentGroup.torrents.filter(
    filterSameEditionGroupAs(editionInfo)
  )

  const probeInfos = await Promise.all(
    origin.files
      .map(({ Name }) => Name)
      .filter((name) => /\.flac$/.test(name))
      .map((name) => `${inputDir}/${name}`)
      .map(probeMediaFile)
  )

  if (!requiredTagsPresent(probeInfos)) {
    console.error(`[!] Required tags are not present! check ${inputDir}`)
    return
  }
  console.log("[+] Required tags are present, would transcode this")

  const files = []

  // will make dirs for FLAC, V0 and 320 transcodes using this as base
  let outputDirBase = `${
    TRANSCODE_DIR || path.dirname(inputDir)
  }/${sanitizeFilename(`${origin.artist} - ${origin.name}`)}`
  const year = editionInfo.remasterYear || origin.originalYear
  if (editionInfo.remasterTitle) {
    // e.g., "Special Edition"
    outputDirBase += ` (${editionInfo.remasterTitle})`
  }

  if (year) {
    // can neither remasterYear nor originalYear ever be present?
    outputDirBase += ` (${year})`
  }
  outputDirBase += ` - ${origin.media}`

  const shouldMakeFLAC = function shouldMakeFLAC() {
    if (origin.encoding !== "24bit Lossless") {
      return false
    }

    if (editionGroup.some((torrent) => torrent.encoding === "Lossless")) {
      return false
    }

    const badBitRate = probeInfos.map(getBitrate).filter((b) => b !== 24)
    if (badBitRate.length > 0) {
      console.error(
        `[!] These are not 24bit flac. Found ${badBitRate.join(
          ","
        )}-bit too. Won't transcode this to flac16`
      )
      return false
    }

    return true
  }

  // torrents will be put in a temp directory before uploading,
  // after uploading they will be moved
  const filesToMove = []
  const tasks = []
  if (shouldMakeFLAC()) {
    const inputSampleRate = getConsistentSampleRate(probeInfos)
    if (!inputSampleRate) {
      console.error(`[!] Inconsistent sample rate! check ${inputDir}`)
    } else {
      tasks.push(() =>
        makeFlacTranscode(
          `${outputDirBase} FLAC`,
          inputDir,
          inputSampleRate % 48000 === 0 ? 48000 : 44100
        )
      )
    }
  }

  for (const [encoding, preset] of Object.entries(MP3_PRESETS)) {
    if (!editionGroup.some((torrent) => torrent.encoding === encoding)) {
      tasks.push(() =>
        makeMp3Transcode(`${outputDirBase} ${preset}`, inputDir, encoding)
      )
    }
  }

  for (const doTranscode of tasks) {
    const { outDir, method, format, bitrate } = await doTranscode()
    const torrentName = `${path.basename(outDir)}.torrent`
    const torrentPath = path.join(TORRENT_DIR, torrentName)
    const tmpPath = path.join(os.tmpdir(), torrentName)
    await mktorrent(outDir, tmpPath)
    filesToMove.push([tmpPath, torrentPath])
    files.push({
      format,
      bitrate,
      torrentPath: tmpPath,
      release_desc: `Source: ${origin.permalink}. Method: ${method}`,
    })
  }

  if (files.length === 0) {
    console.log("[-] No files made, nothing to do")
    return
  }

  const { torrentPath, bitrate, format, release_desc } = files[0]

  const uploadOpts = {
    groupid: torrentGroup.group.id,
    unknown: false, // can this be true?
    remaster_year: editionInfo.remasterYear,
    remaster_title: editionInfo.remasterTitle,
    remaster_record_label: editionInfo.remasterRecordLabel,
    remaster_catalogue_number: editionInfo.remasterCatalogueNumber,
    scene: false,
    media: origin.media,

    file_input: fs.createReadStream(torrentPath),
    bitrate,
    format,
    release_desc,
  }

  if (files[1]) {
    const { torrentPath, bitrate, format, release_desc } = files[1]
    uploadOpts.extra_file_1 = fs.createReadStream(torrentPath)
    uploadOpts.extra_format = [format]
    uploadOpts.extra_bitrate = [bitrate]
    uploadOpts.extra_release_desc = [release_desc]
  }

  if (files[2]) {
    const { torrentPath, bitrate, format, release_desc } = files[2]
    uploadOpts.extra_file_2 = fs.createReadStream(torrentPath)
    uploadOpts.extra_format.push(format)
    uploadOpts.extra_bitrate.push(bitrate)
    uploadOpts.extra_release_desc.push(release_desc)
  }

  const data = await upload(uploadOpts)
  await Promise.all(
    filesToMove.map(([src, dst]) => fs.promises.rename(src, dst))
  )
  console.log("[*] Done!")
}

;(async () => {
  for (const dir of argv._) {
    await main(dir.replace(/\/$/, "")).catch(console.error)
  }
})()
