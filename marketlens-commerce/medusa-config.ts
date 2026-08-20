import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// Le repli `"supersecret"` hérité du starter est acceptable en développement
// et en test, où il est reproductible et sans valeur. Il ne l'est plus une
// fois que ce secret signe les jetons marchands : une variable oubliée en
// production rendrait chaque jeton forgeable avec une valeur publiquement
// documentée par le starter Medusa. On échoue donc au démarrage plutôt que
// de servir en silence.
const secretsManquants = ['JWT_SECRET', 'COOKIE_SECRET'].filter(
  (nom) => !process.env[nom]
)

if (process.env.NODE_ENV === 'production' && secretsManquants.length > 0) {
  throw new Error(
    `Variables d'environnement obligatoires en production non renseignées : ${secretsManquants.join(
      ', '
    )}. Le repli du starter ("supersecret") est publiquement connu et ne doit jamais signer de jeton marchand.`
  )
}

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    }
  },
  modules: [
    {
      resolve: "./src/modules/merchant",
    },
    {
      resolve: "./src/modules/visual-catalog",
    },
  ],
})
