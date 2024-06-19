import axios from "axios"
import q from "querystring"
import FormData from "form-data"
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
      obj[key] = he.decode(value)
    } else if (Array.isArray(value)) {
      // If the property is an array, decode each string element
      obj[key] = value.map((item) => {
        if (typeof item === "string") {
          return he.decode(item)
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

    this.apiClient = axios.create({
      baseURL: process.env.RED_API || "https://redacted.ch",
      headers: {
        Authorization: API_KEY,
        "user-agent": `${pkg.name}@${pkg.version}`,
      },
      validateStatus: (status) => status < 500,
    })

    this.apiClient.interceptors.response.use(function (response) {
      if (response.data?.status !== "success") {
        // mind that the `response` is `AxiosResponse`.
        const { method, url } = response.config
        throw new Error(`${method} ${url}: ${JSON.stringify(response.data)}`)
      }
      if (options.decodeEntities) {
        decodeEntities(response.data)
      }
      return response
    })
  }

  async index() {
    const resp = await this.apiClient.get(`/ajax.php?action=index`)

    return resp.data.response
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
    const resp = await this.apiClient.get(`/ajax.php?${q.encode(query)}`)

    return resp.data.response
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
    const resp = await this.apiClient.get(`/ajax.php?${q.encode(query)}`)

    return resp.data.response
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
        form.append(k, v, `${k}.torrent`)
      } else {
        form.append(k, v)
      }
    }

    const resp = await this.apiClient.post(`/ajax.php?action=upload`, form, {
      headers: {
        ...form.getHeaders(),
      },
    })

    return resp.data.response
  }
}
