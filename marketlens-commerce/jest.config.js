const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

// Les scripts `test:*` de package.json n'utilisent PAS --forceExit.
// Vérifié le 2026-08-20 : les trois suites (http, modules, unit) sortent
// proprement (exit 0) sans ce drapeau, y compris après l'introduction de
// `fetch` (undici) dans src/lib/vision-client.ts. --forceExit masquait un
// vrai échec : sur Windows, jest + --forceExit + fetch fait planter le
// process après coup (assertion libuv UV_HANDLE_CLOSING), avec un code de
// sortie non nul alors que tous les tests sont verts — ce qui casse tout
// enchaînement `&&` et toute CI qui lit le code de sortie.
// Si une suite se met un jour à pendre, c'est le signal qu'une ressource
// (serveur, timer, connexion) n'est pas fermée dans un `finally` — corriger
// la fuite, ne pas rajouter --forceExit.
module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = [
    "**/integration-tests/modules/*.spec.[jt]s",
    "**/src/modules/*/__tests__/**/*.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}
