const axios = require("axios").default
const q = require("querystring")
const FormData = require("form-data")
const pkg = require("./package.json")
const he = require("he");

const DEFAULT_OPTIONS = {
  decodeEntities: true

}

/* Recurses over an entire (acyclic) object. Mutates object entries in-place. */
function decodeEntities(obj) {
  if (obj === null) {
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      obj[key] = he.decode(value);
    } else if (Array.isArray(value)) {
      // If the property is an array, decode each string element
      obj[key] = value.map(item => {
        if (typeof item === 'string') {
          return he.decode(item);
        } else if (typeof item === 'object') {
          // If the element is an object, recursively decode its strings
          decodeEntities(item);
        }
        return item;
      });
    } else if (typeof value === 'object') {
      // If the property is an object, recursively decode its strings
      decodeEntities(value);
    }
  }
}

function initAPI(API_KEY, _options={}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ..._options
  }

  const REDAPI = axios.create({
    baseURL: process.env.RED_API || "https://redacted.ch",
    headers: {
      "Authorization": API_KEY,
      "user-agent": `${pkg.name}@${pkg.version}`,
    },
    validateStatus: (status) => status < 500,
  })

  REDAPI.interceptors.response.use(function (response) {
    if (response.data?.status !== "success") {
      const {method, url} = response.config;
      throw new Error(`${method} ${url}: ${response.data.status}`)
    }
    if (options.decodeEntities) {
      decodeEntities(response.data);
    }
    return response;
  })

  async function index() {
    const resp = await REDAPI.get(`/ajax.php?action=index`)

    return resp.data.response;
  }

  async function torrent({ hash }) {
    const resp = await REDAPI.get(`/ajax.php?${q.encode({
      action: "torrent",
      hash,
    })}`)

    return resp.data.response
  }

  async function torrentgroup({ id, hash }) {
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
    const resp = await REDAPI.get(`/ajax.php?${q.encode(query)}`)

    return resp.data.response
  }

  async function upload(opts) {
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

    const resp = await REDAPI.post(`/ajax.php?action=upload`, form, {
      headers: {
        ...form.getHeaders(),
      },
    })

    return resp.data.response
  }
  return {
    index,
    torrent,
    torrentgroup,
    upload,
  }
}

module.exports = initAPI
