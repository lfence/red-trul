module.exports = {
  env: {
    commonjs: true,
    es2021: true,
    node: true,
  },
  extends: "eslint:recommended",
  parserOptions: {
    ecmaVersion: 13,
  },

  rules: {
    "no-control-regex": 0,
    "no-extra-semi": 0,
  },
}
