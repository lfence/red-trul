const axios = require("axios").default
const q = require("querystring")
const FormData = require("form-data")
const pkg = require("./package.json")

function initAPI (API_KEY) {
  const RED_API = process.env.RED_API || "https://redacted.ch/ajax.php"
  
  const HTTP_AUTHZ_HEADERS = {
    Authorization: API_KEY,
    "user-agent": `${pkg.name}@${pkg.version}`,
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
        if (Array.isArray(v)) for (const el of v) form.append(`${k}[]`, el)
        else form.append(k, v)
      }
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
  return {
    index,
    torrentgroup,
    upload,
  }
}

module.exports = initAPI
