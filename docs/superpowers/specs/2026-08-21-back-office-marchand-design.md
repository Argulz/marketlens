# Lot 4 — Back-office marchand

**Date :** 2026-08-21
**État :** validé, prêt pour le plan d'implémentation
**Prédécesseurs :** `2026-08-16-marketlens-medusa-socle-design.md` (spec du socle),
`notes-plan-3.md`, `notes-plan-4.md` (contraintes héritées)

---

## Pourquoi ce lot

Les lots 1 à 3 ont livré un parcours complet et éprouvé — photographier, détecter,
tarifier, publier, servir la vitrine — mais **il n'existe aucun chemin qui ne passe
pas par `curl`**. Aucune vraie commerçante ne peut utiliser le produit.

Ce lot livre l'écran de la commerçante. Il ne livre ni le panier, ni le paiement,
ni la vitrine définitive.

## Décisions prises au cadrage

Quatre décisions ont été arrêtées avant conception. Elles sont contraignantes.

### D1 — Rendu serveur par Medusa, même origine

Les pages sont servies par Medusa, pas par un Next.js séparé sur le port 8000
comme l'annonçait le README.

Trois raisons, dans l'ordre de poids :

1. **Les routes `/merchant/*` n'ont aucun en-tête CORS.** Le framework n'en pose
   que pour `/store`, `/admin` et `/auth` — vérifié dans le paquet installé. Un
   front sur un autre port serait bloqué par le navigateur avant même
   d'atteindre l'authentification.
2. **La cible est le téléphone Android d'entrée de gamme en 3G.** Livrer un
   paquet JavaScript lourd à ce public est un choix qui se paie.
3. **Un seul service à faire tourner et à déployer.**

Contrepartie assumée : interactions plus modestes qu'avec un cadre front.

### D2 — Les prix restent dans l'image, qui se régénère

L'image annotée grave les prix en pixels (`{price} FCFA`, dessiné par Pillow).
La spec du socle affirmait que « le prix, les variantes et le stock
n'appartiennent pas au catalogue visuel » — c'est vrai des variantes et du stock,
**faux du prix**, et cet amendement figure désormais dans la spec du socle.

Deux voies étaient ouvertes. Retenue : **régénérer l'image à chaque modification
de prix**, et non sortir les prix de l'image.

Le facteur décisif n'est pas technique mais commercial : **la commerçante
distribue son catalogue en envoyant l'image sur WhatsApp**. Une image sans prix
ne serait plus partageable, ce qui casserait le mécanisme de diffusion du
produit.

Le coût est faible : l'annotation est faite par **Pillow, pas par Gemini** — ni
quota, ni latence d'inférence — et `source_image_url` est déjà conservé sur le
catalogue.

En complément : **la vitrine web affiche les prix lus dans Medusa**, en texte,
jamais dans l'image. Si une régénération échoue, le web reste juste.

### D3 — Publication et dépublication ne créent ni ne détruisent de produits

L'identifiant produit est `<handle-boutique>-<libellé>-<8 derniers du zone_id>`,
et l'index `IDX_product_handle_unique` est **globalement unique**. Le `zone_id`
est stable.

Si « dépublier » supprimait les produits et « republier » les recréait, la
republication se heurterait à l'index unique sur les produits qu'elle vient
elle-même d'effacer. Le cycle est donc séparé :

| Action | Effet |
|---|---|
| Publier | Crée les produits, une fois pour toutes. Génère l'image. |
| Dépublier | Repasse le catalogue en `draft`. Produits, stock et historique intacts. |
| Republier | Régénère l'image, repasse en `published`. Aucun produit créé. |
| Corriger un prix | Met à jour le produit existant, régénère l'image. |

Aucune suppression, aucune collision, et une commande passée sur un produit
dépublié reste cohérente. La vitrine cesse de servir par son filtre
`status: "published"` existant.

### D4 — Gabarits par balises littérales auto-échappantes

Le risque réel du rendu serveur n'est pas la technologie : c'est **l'échappement**.
`/c/<handle>` appelle une fonction `echapper()` à la main à chaque interpolation.
Sur six écrans avec des formulaires, un seul oubli ouvre une faille d'injection —
et aucun test de parcours ne le rattrape.

Retenu : une balise littérale d'une vingtaine de lignes, sans dépendance, qui
**échappe toute interpolation par défaut** et exige un marquage explicite pour
insérer du HTML brut. Les pages restent des fonctions TypeScript : composables,
et vérifiées par `tsc`.

Écartés : un moteur de gabarits classique (les gabarits ne sont pas vérifiés par
le compilateur, or `@swc/jest` ne vérifie pas les types — `tsc` a rattrapé sur ce
projet des erreurs que les tests laissaient passer) ; JSX rendu côté serveur
(meilleure composition, mais ajoute une dépendance et un mode de compilation).

Voie de sortie si les écrans devenaient réellement complexes : passer à JSX. Les
pages étant des fonctions, la conversion est mécanique.

---

## Périmètre

### Dans ce lot

Le socle, qui remplace `curl` : connexion, liste des catalogues, prise de photo,
tarification, publication, correction des prix et des stocks.

Plus **la dépublication**, retenue au cadrage parce que la publication est
aujourd'hui à sens unique — 409 en dur sur toute republication, aucune route de
dépublication — et qu'un back-office offrirait sinon un bouton qui n'a rien à
appeler.

Plus **une modification de la vitrine `/c/<handle>`**, qui découle directement de
D2 : elle doit afficher les prix lus dans Medusa, en texte, et non plus laisser
l'image annotée seule porter cette information. C'est ce qui garantit que le web
reste juste même si une régénération d'image échoue. Le reste de la vitrine — le
panier, le paiement, la charte définitive — reste hors de ce lot.

### Hors de ce lot, explicitement

- La modification du profil et la normalisation E.164 des téléphones
  (contrainte 10 de `notes-plan-4.md`, toujours ouverte).
- L'ajout ou le retrait d'un produit dans un catalogue publié.
- Le panier, le paiement, la vitrine acheteur définitive.
- L'inventaire par re-photographie.

---

## Architecture

Un seul service. Medusa sert :

| Préfixe | Rôle |
|---|---|
| `/marchand/*` | Back-office, pages HTML (ce lot) |
| `/c/<handle>` | Vitrine publique, page HTML |
| `/merchant/*` | API marchand, JSON |
| `/store/*`, `/auth/*` | API du framework |
| `/app` | Console opérateur native — **montre les données de tous les marchands** |

### Session

Même origine, donc cookie plutôt que jeton en stockage local :

1. `POST /auth/merchant/emailpass` → jeton
2. `POST /auth/session` avec ce jeton → pose le cookie `connect.sid`
3. Les requêtes suivantes portent le cookie
4. `DELETE /auth/session` déconnecte

**Aucun intergiciel à modifier** : `src/api/middlewares.ts` déclare déjà
`authenticate("merchant", ["session", "bearer"])` sur les routes marchand. Seul
`/merchant/register` reste en jeton pur, ce qui est correct — l'inscription
utilise le jeton d'inscription.

Les pages `/marchand/*` sont protégées par le même mécanisme, et passent toutes
par `marchandActifOuRefus` : une commerçante suspendue est renvoyée vers la
connexion, jamais vers un écran vide.

### Écrans

| Chemin | Rôle |
|---|---|
| `/marchand/connexion` | Connexion et inscription. Pose le cookie. |
| `/marchand` | Liste des catalogues : brouillons à finir, publiés en ligne. |
| `/marchand/nouveau` | Prise de photo, envoi, affichage des zones détectées. |
| `/marchand/catalogues/:id` | Tarification d'un brouillon, puis publication. |
| `/marchand/catalogues/:id/prix` | Correction des prix et des stocks d'un catalogue publié. |

La déconnexion est une action, pas un écran.

### Routes d'API à ajouter

| Route | Rôle |
|---|---|
| `GET /merchant/catalogues/:id` | Détail avec zones et produits. Seule la liste existe aujourd'hui, sans les zones. |
| `POST /merchant/catalogues/:id/unpublish` | Repasse en `draft`. |
| `POST /merchant/catalogues/:id/republish` | Régénère l'image, repasse en `published`. |
| `PATCH /merchant/catalogues/:id/items` | Corrige prix et quantités, régénère l'image. |

### L'annotation devient un flux réutilisable

Elle est aujourd'hui une étape enfermée dans le flux de publication
(`src/workflows/steps/annotate-catalogue.ts`). Trois chemins doivent désormais
l'appeler : publier, republier, corriger un prix.

Elle est extraite en flux prenant `source_image_url` et la liste des produits
tarifés, et rendant l'adresse de la nouvelle image annotée.

---

## Risques nommés

### R1 — La régénération dépend du fichier source d'origine

`source_image_url` est conservé en base, mais rien ne garantit que le fichier
existe encore : purge, changement de fournisseur de stockage, nettoyage manuel.

**Exigence :** une correction de prix dont la régénération échoue doit laisser le
prix Medusa **à jour** et le signaler explicitement à la commerçante. Le pire
comportement serait de laisser croire que rien n'a changé alors que le prix a
bougé et que seule l'image est restée en arrière.

### R2 — Lecture directe des prix, sans contexte de prix calculé

La vitrine lit `variants.prices.amount` plutôt que le prix calculé. C'est simple
et juste dans les conditions actuelles : une seule devise (`xof`), aucune liste de
prix, aucune promotion.

**Limite assumée :** le jour où il y aura des promotions ou plusieurs devises, il
faudra passer par le prix calculé, qui exige un contexte de région.

### R3 — Le handle de boutique reste immuable de fait

Il préfixe tous les identifiants produits. Aucun écran de ce lot ne permet de le
changer, et c'est délibéré. Un futur écran « renommer ma boutique » devra soit
interdire le changement après la première publication, soit réécrire les
identifiants produits.

---

## Erreurs et sécurité

- Tous les messages destinés à la commerçante sont en **français**.
- L'identité vient **toujours** de la session, jamais du client. Aucun paramètre
  d'URL ni de corps ne désigne une boutique.
- Les gabarits **échappent par défaut** ; insérer du HTML brut exige un marquage
  explicite.
- Aucune page de refus ne nomme la boutique ni le catalogue : un handle inconnu,
  un brouillon et une boutique suspendue rendent la même page.
- Une panne amont reste un 5xx. Elle n'est jamais aplatie en 4xx accusant la
  saisie de la commerçante — règle établie au lot 3 après une régression sur ce
  point exact.

## Tests

Les quatre routes d'API sont couvertes en tests HTTP, comme les précédentes.

Pour les pages, deux garanties, et seulement deux :

1. **Échappement** — une valeur hostile injectée dans un nom de boutique ressort
   échappée.
2. **Accès** — une commerçante déconnectée, supprimée ou suspendue n'atteint
   aucun écran.

Le reste de la mise en forme n'est pas testé : ce serait du test de gabarit sans
valeur.

**Règle de méthode, héritée du lot 3 :** un test qui passe du premier coup ne
prouve rien. Chaque garde de sécurité doit être vérifiée **rouge** — en retirant
la garde et en constatant l'échec — avant d'être déclarée couverte.

---

## Contraintes héritées à recopier dans le plan

Le lot 3 a laissé passer une exigence écrite en gras dans la spec du socle parce
que ses contraintes globales ne l'avaient pas recopiée : toute l'exécution s'est
vérifiée contre le plan, jamais contre la spec.

**Le plan d'implémentation de ce lot doit recopier item par item :**

1. Refus de toute route et de tout écran pour un marchand dont le statut n'est
   pas `active` — 403 côté marchand, 404 côté vitrine.
2. Identité issue de la session, jamais du client.
3. Aucune clé étrangère inter-modules ; les rattachements passent par
   `defineLink`.
4. Messages en français, sans fuite de détail technique.
5. Une panne amont sort en 5xx, jamais en 4xx.
6. `--forceExit` interdit dans les scripts de test.
7. `npm run typecheck` doit sortir 0 — `@swc/jest` ne vérifie pas les types.
8. Tests HTTP en deltas, jamais en zéros absolus : la base est partagée.
9. Une zone peut ne porter aucun produit : la commerçante ne tarifie pas
   forcément tout ce qui est détecté.
10. `detected_label` et `product.title` divergent par construction — décider
    lequel chaque écran affiche.
11. La base de développement ne contient aucune image annotée exploitable : les
    28 catalogues importés du corpus portent un JPEG factice de 6 octets. Les
    écrans doivent être développés contre une analyse fraîche.
12. Quantité par variante, non répartie : « 4 pagnes, 2 couleurs, 2 tailles » = 16
    unités en stock. Le lot 3 avait signalé cette décision produit comme « à
    trancher plutôt qu'à subir » ; elle ne l'a jamais été, et **ce lot est celui
    qui la rend visible à la commerçante** — l'écran de tarification affiche
    forcément un chiffre. Le plan doit donc la trancher explicitement : soit la
    quantité saisie est par variante (comportement actuel, à assumer et à
    libeller clairement dans l'écran), soit elle est un total à répartir, ce qui
    change le contrat de `PATCH /merchant/catalogues/:id/items` et la façon dont
    le stock est posé. Ne pas la trancher revient à la trancher par omission.
