#!/usr/bin/env node
const yaml = require("yaml")
const fs = require("fs")
const path = require("path")
const os = require("os")
const pkg = require("./package.json")
const _execFile = require("child_process").execFile
const yargs = require("yargs")

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
  .option("verbose", {
    boolean: true,
    describe: "Print more",
  })
  .help("h")
  .alias("h", "help").argv

const VERBOSE = argv["verbose"]

const verboseLog = (...args) => {
  if (VERBOSE) console.log('[VERBOSE]', ...args)
}

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
        try {
          await fs.promises.mkdir(`${outDir}/${file}`)
	} catch(e) {
          if (e.code !== "EEXIST") {
            throw e;
          }
        }
        const ncopied = await copyOtherFiles(`${inDir}/${file}`, `${outDir}/${file}`)
        if (ncopied == 0) {
          // directory is empty
          await fs.promises.rmdir(`${outDir}/${file}`)
        }
      }
    }
  }
  return Promise.all(
    files
      .filter((f) => /\.(jpe?g|png)$/.test(f))
      .map((file) =>
        fs.promises.copyFile(`${inDir}/${file}`, `${outDir}/${file}`)
      )
  ).then((n) => n.length)
}

async function makeFlacTranscode(outDir, inDir, sampleRate) {
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
      await execFile(
        "sox",
        [
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
        ],
        !VERBOSE
      )
    }
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

const filterSameEditionGroupAs = ({
  media,
  remasterTitle,
  remasterCatalogueNumber,
  remasterYear,
  remasterRecordLabel,
}) =>
  function filterSameEdition(torrent) {
    if (torrent.media !== media) return false
    if (torrent.remasterTitle !== remasterTitle) return false
    if (torrent.remasterCatalogueNumber !== remasterCatalogueNumber) return false
    if (torrent.remasterRecordLabel !== remasterRecordLabel) return false
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
  const origin = await fs.promises.readFile(originPath)
  const parsed = yaml.parse(origin.toString("utf-8"))

  // parse and transform object keys, eg. o["Edition Year"] -> o.editionYear
  return Object.fromEntries(
    // API uses empty string but Origin gets null. Normalize
    Object.entries(parsed).map(([k, v]) => [toCamelCase(k), v  ?? ""])
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

  for (const [encoding, preset] of Object.entries(MP3_PRESETS)) {
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
    await copyOtherFiles(inDir, outDir)
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
      }
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

  console.log("[-] Uploading...")
  await redAPI.upload(uploadOpts)
  console.log("[-] Write torrents...")
  await Promise.all(
    files.map(({ fileName, postData }) =>
      fs.promises.writeFile(`${TORRENT_DIR}/${fileName}`, postData.file_input)
    )
  )
  console.log("[*] Done!")
}

;(async () => {
  for (const dir of argv._) {
    await main(dir.replace(/\/$/, "")).catch(console.error)
  }
})()
