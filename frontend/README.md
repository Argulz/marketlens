# Interface historique du monolithe — conservée comme référence

**Ce répertoire n'est pas servi et n'est plus maintenu.** Il n'est appelé par
aucun service actuel : Medusa sert le banc d'essai sur `/demo` et la vitrine
publique sur `/c/<handle>`, tous deux écrits pendant le lot 3.

Il est conservé pour une raison précise : c'est le **seul témoignage de ce à
quoi MarketLens ressemblait** avant la migration, et donc la référence de
conception du lot 4.

| Fichier | Ce qu'il documente |
|---|---|
| `catalogue_share.html` | La vitrine publique complète : image annotée, compteur de produits, **panier**, **bouton de paiement**, modales. C'est le parcours acheteur que le lot 4 doit retrouver. |
| `index.html` | Le parcours marchand : prise de photo, annotation, publication. |
| `js/catalogue.js` | La logique de vitrine côté client. |
| `js/app.js` | La logique marchande côté client. |
| `css/style.css` | 1288 lignes de mise en forme — la charte visuelle du produit. |

## Ce qu'il faut en retenir, et ce qu'il ne faut pas en reprendre

**À reprendre :** la charte visuelle, le parcours acheteur, la place du panier
et du bouton de paiement dans la page, la façon dont l'image annotée occupe
l'écran.

**À ne pas reprendre :** le modèle de données. L'ancienne version stockait les
prix, les couleurs et les tailles dans le même objet que la photo. Medusa les
porte désormais dans des entités distinctes, et cette séparation est ce qui
rend possible l'inventaire par re-photographie. Les pertes de représentation
que la migration entraîne sont recensées dans
`docs/superpowers/specs/notes-plan-4.md`.

Supprimer ce répertoire ferait perdre la seule trace de l'interface d'origine.
Il pèse 92 Ko.
