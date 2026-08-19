# Notes pour le plan 3 — catalogue visuel

Contraintes héritées du lot 1 (socle commerce et multi-tenance). Elles ne sont
pas des préférences de style : chacune est issue d'un comportement vérifié du
framework et gardée par un test.

## Le groupement par marchand ne passe ni par les collections ni par les catégories Medusa

**Constat.** `/store/products` et `/store/carts` sont filtrés par le canal de
vente porté par la clé publiable. `/store/collections` et
`/store/product-categories` ne le sont **pas** : ces ressources sont globales à
l'instance. Sondé sur deux marchands A et B :

```
clé publiable de B → collections : ["Collection secrète de A"]   ← données de A
clé publiable de B → categories  : ["Catégorie secrète de A"]    ← données de A
clé publiable de B → produits    : []                            ← correctement filtré
```

Sont également globaux : les régions, les tags et les types de produits.

**Ce qui est verrouillé.** Le test
`marketlens-commerce/integration-tests/http/merchant-isolation.spec.ts`
contient un cas nommé `LIMITE CONNUE : les collections et les catégories ne sont
PAS cloisonnées par le canal de vente`. Il assert la fuite. S'il devient rouge,
c'est que Medusa a changé de comportement et que la contrainte ci-dessous peut
être relâchée — pas qu'une régression est apparue.

**La contrainte.** Le catalogue visuel groupe des produits par marchand. Le
premier réflexe — une collection Medusa ou une catégorie de produits par
marchand ou par catalogue — **produirait une fuite de noms de regroupement d'un
marchand à l'autre** dès la première vitrine publiée : le nom du regroupement de
A serait visible depuis la vitrine de B.

Donc :

- **Jamais de regroupement par marchand porté par une collection ou une
  catégorie Medusa sans filtrage applicatif explicite.** Le rattachement
  marchand ↔ catalogue passe par un `defineLink` du module `visual-catalog`
  vers `merchant`, et toute lecture de vitrine filtre explicitement sur ce lien
  ou sur le `sales_channel_id` du marchand.
- Si une collection Medusa est malgré tout utilisée pour un besoin de
  présentation, la route qui l'expose est une route de ce dépôt (pas
  `/store/collections`), et elle applique le filtre elle-même.
- Toute nouvelle route de vitrine ajoute son cas au test d'isolation. La règle
  du lot 1 tient : une fuite non testée est une fuite.

## Le `handle` est un slug minuscule, et l'URL `/c/[handle]` en dépend

`POST /merchant/register` normalise `handle` en minuscules et impose
`^[a-z0-9]+(-[a-z0-9]+)*$`. L'index unique de Postgres est sensible à la casse :
sans cette normalisation, `etal-fatou` et `ETAL-FATOU` seraient deux locataires
distincts se disputant la même URL publique de catalogue. Le `handle` du
`VisualCatalogue` (qui apparaît, lui, dans `/c/[handle]`) doit appliquer la même
normalisation et le même motif, pour la même raison.

## Un marchand non `active` n'est pas servi

`status` est lu, pas décoratif : `pending` et `suspended` sont refusés en 403
avec un message français. Toute route de vitrine ou de back-office ajoutée au
plan 3 applique la même règle — une vitrine publiée par un marchand suspendu ne
doit pas rester servie.

## Devise et langue

- Devise `xof` en **minuscules**, partout, y compris dans les prix créés par
  `createProductsWorkflow`.
- Messages destinés à l'utilisateur **en français**, pour toute route écrite
  dans ce dépôt. Seuls les messages rendus par le framework sur des routes que
  ce dépôt ne possède pas restent en anglais (limite acceptée, documentée dans
  la spec du lot 1).
