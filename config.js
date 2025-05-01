import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import YAML from "yaml"
import path from "path"
import debug from "debug"
const verboseLog = debug("trul:cli")

import { readFileSync, existsSync, realpathSync } from "fs"
const __dirname = path.dirname(realpathSync(process.argv[1]))
const pkg = JSON.parse(readFileSync(`${__dirname}/package.json`))

const _initConfig = (argv) => {
  const FLAC_DIR = argv._[0]?.replace(/\/$/, "")
  return {
    ALWAYS_TRANSCODE: argv["always-transcode"],
    API_KEY: argv["api-key"] || getEnv("RED_API_KEY"),
    // input dir
    FLAC_DIR,
    // transcode output
    TRANSCODE_DIR: argv["transcode-dir"] || path.dirname(FLAC_DIR ?? ""),
    // torrent output
    TORRENT_DIR: argv["torrent-dir"],
    SOX: getEnv("SOX_PATH") || "sox",
    SOX_ARGS: "-G <in.flac> -b16 <out.flac> rate -v -L <rate> dither",
    // flac2mp3 for idv3 and to copy cover art over. The rest is LAME.
    FLAC2MP3: getEnv("FLAC2MP3_PATH") || `${__dirname}/flac2mp3/flac2mp3.pl`,
    FLAC2MP3_ARGS: "--lameargs=<args> --processes=<nproc>",
    NO_UPLOAD: argv["upload"] === false,
    NO_V0: argv["v0"] === false,
    NO_320: argv["320"] === false,
    NO_FLAC: argv["flac"] === false,
    SCRIPT_NAME: `${pkg.name}@${pkg.version}`,
    TORRENT_QUERY: getTorrentQuery(FLAC_DIR, argv),
  }
}

export const initConfig = () => {
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


  if (!argv._[0]) {
    console.error(`No input, nothing to do. Try '--help'`)
    process.exit(0);
  }

  const config = _initConfig(argv)

  verboseLog('Config: ')
  verboseLog(config)
  return config;
}

export function getEnv(e) {
  return process.env[e]
}

function getTorrentQuery(FLAC_DIR, argv) {
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

  throw new Error(
    "[!] Unable to find an info hash or id. Try --help\n" +
      "Did you forget to pass --info-hash or --id?",
  )
}
