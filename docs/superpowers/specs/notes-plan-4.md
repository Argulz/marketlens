# Notes pour le plan 4 — contraintes héritées du lot 3

Ce document existe pour une raison précise : le plan 3 n'a pas recopié dans ses
Global Constraints une contrainte écrite en gras dans la spec (le contrôle de
statut marchand). Elle a traversé huit tâches et dix revues sans être vue, parce
que chaque vérification s'est faite **contre le plan** et non contre la spec.

**Le plan 4 doit recopier chacun des points ci-dessous dans ses Global
Constraints, ou les référencer item par item dans sa liste de vérification
finale. Une contrainte non recopiée est une contrainte qui ne sera jamais
vérifiée.**

---

## 1. La vitrine ne peut pas être construite avec ce que rend l'API actuelle

`GET /store/catalogues/:handle` ne rend **ni prix, ni clé publiable, ni le
WhatsApp du vendeur** — seuls `variants.id` et `variants.title` sont projetés.
Le plan 4 ne peut donc ni afficher un prix, ni ouvrir un panier, ni contacter le
vendeur avec cette route. Or « WhatsApp relie vendeur et acheteur » est la
fonction centrale du produit.

Pire, il y a une **impasse circulaire** : `ensurePublishableApiKeyMiddleware` est
monté par le framework sur tout le namespace `/store` (hors du système de
matchers du dépôt), donc la route exige `x-publishable-api-key`. Mais la clé est
**par marchand**, et la page `/c/<handle>` ne sait pas à quel marchand appartient
le handle *avant* d'avoir appelé la route. Le test HTTP contourne le problème en
réutilisant la clé du marchand qu'il vient de créer — ce qui ne reproduit pas la
situation d'un visiteur anonyme.

**C'est la première chose à concevoir du plan 4.** Il faut soit étendre cette
route, soit ajouter une route de résolution `handle → marchand`.

À acter aussi noir sur blanc : cette route interroge par handle **sans aucun
filtrage par canal de vente**. La spec présente la clé publiable comme ce qui
« garantit l'isolation au niveau du framework » — cette garantie ne s'applique
pas aux routes écrites dans ce dépôt. Ce n'est pas une fuite (une vitrine
publiée est publique par destination, et l'image source n'est jamais exposée),
mais l'assurance de la spec ne couvre pas cette route.

## 2. Les prix sont incrustés dans l'image annotée

C'est le point de fond. `annotated_image_url` est une image dans laquelle le
service Python **grave les prix**. Le catalogue visuel porte donc bien de
l'information de prix — sous forme de pixels, dans un champ qui lui appartient.

La spec écrit « quand le stock changera, la vitrine le reflétera sans qu'on
retouche le catalogue visuel ». C'est vrai du stock et **faux du prix** : toute
modification de prix dans Medusa désynchronise silencieusement l'image que le
client voit de la vérité du système. Rien ne détecte ni ne signale cette dérive.

Ce n'est pas une erreur d'implémentation — c'est un **défaut de conception de la
spec**, qui énonce une séparation à trois termes (prix, variantes, stock) alors
que son propre artefact central en re-capture un.

**À trancher avant de dessiner l'écran d'édition des prix**, deux voies :
- l'édition post-publication déclenche une ré-annotation (il faut alors
  conserver la clé du fichier source) ;
- le prix sort de l'image et passe en surimpression HTML côté vitrine — solution
  architecturalement propre, qui rendrait la séparation réellement vraie.

## 3. La publication est à sens unique

Un catalogue publié ne peut être **ni dépublié, ni republié, ni corrigé** (409 en
dur). Il n'existe aucune route de mise à jour de produit, de prix ou de stock
dans tout le lot 1. Un back-office qui offre un bouton « Modifier » n'a rien à
appeler.

## 4. Le contrôle de statut marchand

Corrigé dans la passe finale du plan 3 : `marchandActifOuRefus` refuse en 403 sur
les routes marchand et en 404 sur la vitrine. **Toute route ajoutée au plan 4 —
back-office comme vitrine — applique la même règle.** C'est la contrainte qui a
été manquée une fois ; elle ne doit pas l'être deux fois.

## 5. Une zone peut ne porter aucun produit

Le marchand ne tarife pas forcément toutes les zones détectées — l'import du
corpus le fait déjà. `zones[].product` sera `null` sur la vitrine : à gérer, pas
à supposer.

## 6. `detected_label` et `product.title` divergent par construction

Le marchand renomme au brouillon. Les deux sont exposés. Décider lequel
l'interface affiche, et pour qui (le marchand voit son titre, l'acheteur voit
quoi ?).

## 7. Quantité par variante, non répartie — décision jamais prise

« 4 pagnes, 2 couleurs, 2 tailles » = **16 unités en stock**. Le plan 3 signalait
explicitement cette décision produit comme « à trancher plutôt qu'à subir » ;
**elle n'a jamais été tranchée**, aucun ruling ne s'en est saisi. C'est
l'interface du plan 4 qui la rendra visible au marchand. À décider avant, pas
après.

## 8. Le handle marchand est immuable de fait

Il préfixe tous les handles produits. Un écran « renommer ma boutique » doit être
interdit après la première publication, ou réécrire les handles produits.

## 9. La base de développement ne contient aucune image annotée exploitable

Les 28 catalogues importés du corpus portent un JPEG factice de **6 octets**
(l'import rejoue les métadonnées sans appeler Gemini). Les écrans devront être
développés contre une analyse fraîche, service de vision réel.

## 10. Le modèle d'identité marchande est plus fragile qu'il n'y paraît

Cinq pertes de représentation, pas quatre — la cinquième a été trouvée par la
revue finale, après qu'une revue précédente ait déclaré la liste exhaustive.
Deux défauts de conception, pas des bogues de script :

- **Aucune normalisation de téléphone.** Le même marchand « Excharge » apparaît
  sous deux téléphones dans le corpus et compte donc pour deux marchands. Et les
  trois valeurs WhatsApp de son groupe (`95206533`, `22995206533`, `+22995206533`)
  sont **un seul numéro sous trois formats**. Un lien `wa.me` construit sur la
  valeur locale à 8 chiffres ne joindra personne. → **normalisation E.164 à
  l'inscription.**
- **Aucune notion d'historique de nom.** `merchant_name` est per-catalogue dans
  l'ancien modèle et per-marchand dans le nouveau : le vendeur qui signe 16
  catalogues « Excharge » est enregistré « Excel ». → décision explicite sur ce
  qui se passe quand un marchand change de nom.

Sans ces deux décisions, le corpus réel produira des doublons de marchands et des
liens WhatsApp inopérants.

## 11. Blocages de déploiement, toujours ouverts

Hors périmètre du plan 4 mais à ne pas perdre :
- l'admin Medusa natif sur le port 9000 **expose les données de tous les
  marchands** à quiconque y accède ;
- le garde 413 du service de vision ne protège rien, parce que Starlette
  bufferise tout le corps avant de le voir (et écrit les envois > 1 MiB sur
  disque, ce qui contredit la contrainte « stateless ») — il faut une limite de
  corps au niveau du reverse-proxy.

## 12. Piste technique déjà relevée

Une méthode dédiée sur `VisualCatalogModuleService` (où `baseRepository_` est un
membre légitime) permettrait d'écrire catalogue + zones dans une **transaction
unique** et de fermer définitivement la fenêtre de double échec de R15.
