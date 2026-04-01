import { fetch, FormData } from "undici"
import q from "querystring"
import he from "he"
import path from "path"
import { readFileSync, realpathSync } from "fs"
const pkg = JSON.parse(
  readFileSync(
    path.join(path.dirname(realpathSync(process.argv[1])), "package.json"),
  ),
)

/* Recurses over an entire (acyclic) object. Mutates object entries in-place.
 * Decodes html-entities, e.g., "L&oslash;msk" to "Lømsk" */
function decodeEntities(obj) {
  if (obj === null) {
    return
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // on rare occasions we get double-encoded filenames like
      // "1 - &#10042;&amp;#120372;&#4117;&amp;#120520;&#10042;.flac"
      obj[key] = he.decode(he.decode(value))
    } else if (Array.isArray(value)) {
      // If the property is an array, decode each string element
      obj[key] = value.map((item) => {
        if (typeof item === "string") {
          return he.decode(he.decode(item))
        } else if (typeof item === "object") {
          // If the element is an object, recursively decode its strings
          decodeEntities(item)
        }
        return item
      })
    } else if (typeof value === "object") {
      // If the property is an object, recursively decode its strings
      decodeEntities(value)
    }
  }
}

export default class REDAPIClient {
  constructor(API_KEY, _options = {}) {
    const options = {
      decodeEntities: true,
      ..._options,
    }

    this.baseURL = process.env.RED_API || "https://redacted.sh"
    this.defaultHeaders = {
      Authorization: API_KEY,
      "user-agent": `${pkg.name}@${pkg.version}`,
    }
    this.options = options
  }

  async _request(method, url, { headers = {}, body } = {}) {
    const response = await fetch(this.baseURL + url, {
      method,
      headers: { ...this.defaultHeaders, ...headers },
      body,
    })

    if (response.status >= 500) {
      throw new Error(`${method} ${url}: HTTP ${response.status}`)
    }

    const data = await response.json()

    if (data?.status !== "success") {
      throw new Error(`${method} ${url}: ${JSON.stringify(data)}`)
    }

    if (this.options.decodeEntities) {
      decodeEntities(data)
    }

    return data
  }

  async index() {
    const data = await this._request("GET", `/ajax.php?action=index`)
    return data.response
  }

  async torrent({ id, hash }) {
    const query = {
      action: "torrent",
    }
    if (id) {
      query.id = id
    } else if (hash) {
      query.hash = hash
    } else {
      throw new Error("args")
    }
    const data = await this._request("GET", `/ajax.php?${q.encode(query)}`)
    return data.response
  }

  async torrentgroup({ id, hash }) {
    const query = {
      action: "torrentgroup",
    }
    if (id) {
      query.id = id
    } else if (hash) {
      query.hash = hash
    } else {
      throw new Error("args")
    }
    const data = await this._request("GET", `/ajax.php?${q.encode(query)}`)
    return data.response
  }

  async upload(opts) {
    const form = new FormData()

    for (const [k, v] of Object.entries(opts).filter(([, v]) => v)) {
      if (v == null) continue
      if (Array.isArray(v)) {
        for (const el of v) {
          form.append(`${k}[]`, el)
        }
      } else if (["file_input", "extra_file_1", "extra_file_2"].includes(k)) {
        form.append(k, new Blob([v]), `${k}.torrent`)
      } else {
        form.append(k, v)
      }
    }

    const data = await this._request("POST", `/ajax.php?action=upload`, { body: form })
    return data.response
  }
}
