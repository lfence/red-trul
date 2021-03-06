#!/usr/bin/env node
const yaml = require("yaml")
const fs = require("fs").promises
const path = require("path")
const os = require("os")
const pkg = require("./package.json")
const _execFile = require("child_process").execFile
const yargs = require("yargs")
const { decode } = require("html-entities")

const initApi = require("./red-api")

const createTorrent = require("util").promisify(require("create-torrent"))

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
  .option("no-upload", {
    describe: "Won't upload anything",
    boolean: true,
  })
  .option("verbose", {
    boolean: true,
    describe: "Print more",
  })
  .help("h")
  .alias("h", "help").argv

const VERBOSE = argv["verbose"]

const verboseLog = (...args) => {
  if (VERBOSE) console.log("[VERBOSE]", ...args)
}

// supported presets <encoding,flac2mp3_preset>
const mp3presets = []

// Some stupid trick turns everything "--no-" into the opposite.
// https://github.com/yargs/yargs/blob/main/docs/tricks.md
if (argv["v0"] === false) {
  verboseLog("[-] Won't transcode V0")
} else {
  mp3presets.push({ encoding: "V0 (VBR)", preset: "V0" })
}

if (argv["320"] === false) {
  verboseLog("[-] Won't transcode 320")
} else {
  mp3presets.push({ encoding: "320", preset: "320" })
}

const nproc = os.cpus().length

// API_KEY requires 'Torrents' permission.
const API_KEY = argv["api-key"] || process.env.RED_API_KEY
if (!API_KEY) {
  console.error("Missing required argument '--api-key'. Try '--help' for help")
  process.exit(1)
}

const redAPI = initApi(API_KEY)

// Will set it if unset
let ANNOUNCE_URL = argv["announce"]

// Transcodes end here. If unset they end up next to the input dir
const TRANSCODE_DIR = argv["transcode-dir"]

// Ready torrents end here (rtorrent watches this dir and auto adds torrents)
const TORRENT_DIR = argv["torrent-dir"]

async function ensureDir(dir) {
  const stats = await fs.stat(dir, { throwIfNoEntry: false })
  if (!stats) {
    console.error(`${dir} does not exist! Please create it.`)
    process.exit(1)
  }
  if (!stats.isDirectory()) {
    console.error(`${dir} is not a directory.`)
    process.exit(1)
  }
}

async function checkArgs() {
  if (argv._.length == 0) {
    console.error(`No inputs, nothing to do. Try '--help'`)
    process.exit(1)
  }
  if (TRANSCODE_DIR) {
    // not required
    await ensureDir(TRANSCODE_DIR)
  }
  await ensureDir(TORRENT_DIR)
}

const FLAC2MP3_PATH =
  process.env.FLAC2MP3 || `${__dirname}/flac2mp3/flac2mp3.pl`

const sanitizeFilename = (filename) =>
  filename
    .replace(/\//g, "???") // Note that is not a normal / but a utf-8 one
    .replace(/^~/, "")
    .replace(/\.$/g, "_")
    .replace(/[\x01-\x1f]/g, "_")
    .replace(/[<>:"?*|]/g, "_")
    .trim()

function execFile(cmd, args, mute) {
  return new Promise((resolve, reject) => {
    verboseLog(`execFile: ${cmd} ${args.join(" ")}`)
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

const mkdirpMaybe = (() => {
  const exists = {}
  return async function mkdirpMaybe(dir) {
    if (!exists[dir]) {
      await fs.mkdir(dir, { recursive: true })
      exists[dir] = true
    }
  }
})()

// gives an iterator<{file, dir}>, where entries exclude baseDir.
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

async function makeFlacTranscode(outDir, inDir, sampleRate) {
  for await (let { file, dir } of traverseFiles(inDir)) {
    if (!/\.flac$/.test(file)) continue
    await mkdirpMaybe(path.join(outDir, dir))
    const src = path.join(inDir, dir, file)
    const dst = path.join(outDir, dir, file)
    console.log(`[-] Transcoding ${file}...`)
    await execFile(
      "sox",
      [
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
      ],
      !VERBOSE
    )
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

const filterSameEditionGroupAs = ({
  media,
  remasterTitle,
  remasterCatalogueNumber,
  remasterYear,
  remasterRecordLabel,
}) =>
  function filterSameEdition(torrent) {
    if (torrent.media !== media) return false
    // Sometimes special chars are html-entity encoded
    // e.g., "L&oslash;msk" vs "L??msk"
    if (decode(torrent.remasterTitle) !== remasterTitle) return false
    if (torrent.remasterCatalogueNumber !== remasterCatalogueNumber)
      return false
    if (decode(torrent.remasterRecordLabel) !== remasterRecordLabel)
      return false
    if (torrent.remasterYear !== remasterYear) return false
    return true
  }

const toCamelCase = (str) =>
  str
    .split(" ")
    .map((word) => word.toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join("")
    .replace(/^./, (c) => c.toLowerCase())

async function getOrigin(originPath) {
  const origin = await fs.readFile(originPath)
  const parsed = yaml.parse(origin.toString("utf-8"))

  // parse and transform object keys, eg. o["Edition Year"] -> o.editionYear
  return Object.fromEntries(
    // API uses empty string but Origin gets null. Normalize
    Object.entries(parsed).map(([k, v]) => [toCamelCase(k), v ?? ""])
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

async function main(inDir) {
  const origin = await getOrigin(`${inDir}/origin.yaml`)

  if (origin.format !== "FLAC") {
    console.log("[-] Not a flac, not interested")
    return
  }

  if (!ANNOUNCE_URL) {
    ANNOUNCE_URL = await (async () => {
      try {
        const { passkey } = await redAPI.index()
        return `https://flacsfor.me/${passkey}/announce`
      } catch (e) {
        console.error(`Can't GET ?action=index: ${e.message}`)
        process.exit(1)
      }
    })()
  }
  console.log(`[-] using announce: ${ANNOUNCE_URL}`)

  const torrentGroup = await redAPI.torrentgroup({ hash: origin.infoHash })

  const editionInfo = {
    media: origin.media,
    remasterTitle: origin.edition,
    remasterCatalogueNumber: origin.catalogNumber,
    remasterYear: origin.editionYear || origin.originalYear,
    remasterRecordLabel: origin.recordLabel,
  }
  console.log("[-] permalink:", origin.permalink)
  console.log(
    "[-] link:",
    `https://redacted.ch/torrents.php?id=${torrentGroup.group.id}`
  )

  const editionGroup = torrentGroup.torrents.filter(
    filterSameEditionGroupAs(editionInfo)
  )
  if (editionGroup.length === 0) {
    throw Error("Edition group should at lesat contain the current release")
  }

  const probeInfos = await Promise.all(
    origin.files
      .map(({ Name }) => Name)
      .filter((name) => /\.flac$/.test(name))
      .map((name) => `${inDir}/${name}`)
      .map(probeMediaFile)
  )

  const okTags = probeInfos.some((pi) => {
    const tags = Object.keys(pi.format.tags).map((key) => key.toUpperCase())
    return ["TITLE", "ARTIST", "ALBUM", "TRACK"].every((t) => tags.includes(t))
  })

  if (!okTags) {
    console.error(`[!] Required tags are not present! check ${inDir}`)
    return
  }
  console.log("[+] Required tags are present, would transcode this")

  // will make dirs for FLAC, V0 and 320 transcodes using this as base
  let outputDirBase = `${
    TRANSCODE_DIR || path.dirname(inDir)
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
      // a flac16 already exists.
      return false
    }

    const getBitrate = (probeInfo) => {
      const flacStream = probeInfo.streams.find(
        ({ codec_name }) => codec_name === "flac"
      )
      return Number.parseInt(flacStream.bits_per_raw_sample, 10)
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
  const tasks = []
  if (shouldMakeFLAC()) {
    verboseLog("Will make FLAC 16")
    const inputSampleRate = getConsistentSampleRate(probeInfos)
    if (!inputSampleRate) {
      console.error(`[!] Inconsistent sample rate! check ${inDir}`)
    } else {
      const outDir = `${outputDirBase} FLAC`
      const sampleRate = inputSampleRate % 48000 === 0 ? 48000 : 44100
      tasks.push({
        inDir,
        outDir,
        doTranscode: () => makeFlacTranscode(outDir, inDir, sampleRate),
        message: `Source: ${origin.permalink}. Method: sox -G input.flac -b16 output.flac rate -v -L ${sampleRate} dither`,
        format: "FLAC",
        bitrate: "Lossless",
      })
    }
  }

  for (const { encoding, preset } of mp3presets) {
    if (editionGroup.some((torrent) => torrent.encoding === encoding)) {
      verboseLog(`${encoding} already exists. Skip`)
      // this encoding already available. no need to transcode
      continue
    }
    const outDir = `${outputDirBase} ${preset}`
    tasks.push({
      inDir,
      outDir,
      doTranscode: () =>
        execFile(FLAC2MP3_PATH, [
          "--quiet",
          `--preset=${preset}`,
          `--processes=${nproc}`,
          inDir,
          outDir,
        ]),
      message: `Source: ${origin.permalink}. Method: flac2mp3 --preset=${preset}`,
      format: "MP3",
      bitrate: encoding,
    })
  }

  const files = []
  for (const t of tasks) {
    const { inDir, outDir, doTranscode, message, format, bitrate } = t
    console.log(`[-] Transcoding ${outDir}`)
    await doTranscode()
    await copyOtherFiles(outDir, inDir)
    const torrent = await createTorrent(outDir, {
      private: true,
      createdBy: `${pkg.name}@${pkg.version}`,
      announce: ANNOUNCE_URL,
      info: { source: "RED" },
    })
    files.push({
      fileName: `${path.basename(outDir)}.torrent`,
      postData: {
        format,
        bitrate,
        release_desc: message,
        file_input: torrent,
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
    groupid: torrentGroup.group.id,
    remaster_year: editionInfo.remasterYear,
    remaster_title: editionInfo.remasterTitle,
    remaster_record_label: editionInfo.remasterRecordLabel,
    remaster_catalogue_number: editionInfo.remasterCatalogueNumber,
    media: editionInfo.media,
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
  if (argv["upload"] === false) {
    console.log("[-] Skip upload...")
  } else {
    console.log("[-] Uploading...")
    await redAPI.upload(uploadOpts)
  }
  console.log("[-] Write torrents...")
  await Promise.all(
    files.map(({ fileName, postData }) =>
      fs.writeFile(`${TORRENT_DIR}/${fileName}`, postData.file_input)
    )
  )
  console.log("[*] Done!")
}

;(async () => {
  await checkArgs()
  for (const dir of argv._) {
    await main(dir.replace(/\/$/, "")).catch(console.error)
  }
})()
