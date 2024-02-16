#!/usr/bin/env node
import fs from "node:fs"
import { createHash } from "node:crypto"
import { extname } from "node:path"
import bencode from "bencode"
const torrPath = process.argv[2]
if (!torrPath || extname(torrPath) != ".torrent" || !fs.existsSync(torrPath)) {
  console.log(`Usage: ${process.argv[1]} <torrentPath>`)
  process.exit(1)
}
const f = fs.readFileSync(process.argv[2])
console.log(
  createHash("sha1")
    .update(bencode.encode(bencode.decode(f).info))
    .digest()
    .reduce((str, byte) => str + byte.toString(16), "")
    .toUpperCase(),
)
