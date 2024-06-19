import YAML from "yaml"
import path from "path"
import { readFileSync, existsSync, realpathSync } from "fs"
const __dirname = path.dirname(realpathSync(process.argv[1]))
const pkg = JSON.parse(readFileSync(`${__dirname}/package.json`))

export const initConfig = (argv) => {
  const FLAC_DIR = argv._[0].replace(/\/$/, "")
  return {
    ALWAYS_TRANSCODE: argv["always-transcode"],
    API_KEY: argv["api-key"] || getEnv("RED_API_KEY"),
    // input dir
    FLAC_DIR,
    // transcode output
    TRANSCODE_DIR: argv["transcode-dir"] || path.dirname(config.FLAC_DIR),
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

  throw new Error("[!] Unable to find an info hash or id.")
}
