// Le calcul de stock (D5 : quantité PAR DÉCLINAISON, pas répartie) vivait
// dans une chaîne de gabarit côté route, sa justesse n'était établie que par
// relecture humaine (finding R14). Ces fonctions sont désormais un module
// serveur ordinaire, importées ici ET injectées telles quelles dans la page
// via `.toString()` (voir `src/api/marchand/catalogues/[id]/route.ts`) :
// le code exécuté dans le navigateur est exactement celui exercé ici, pas
// une copie qui pourrait diverger de la formule livrée.
//
// Contrainte qui en découle, rappelée dans le brief : ces fonctions ne
// ferment sur rien d'extérieur (pas de variable de portée, pas d'import) —
// seulement leurs paramètres et des primitifs JavaScript.
import {
  calculerStockTotal,
  compterDeclinaisons,
  lireQuantite,
  texteStock,
} from "../../src/lib/pages/stock"

describe("Calcul du stock par déclinaison (D5)", () => {
  describe("lireQuantite", () => {
    it("lit une quantité entière valide", () => {
      expect(lireQuantite("4")).toEqual({ valide: true, valeur: 4 })
    })

    it("traite une quantité vide comme zéro (comportement historique du champ)", () => {
      expect(lireQuantite("")).toEqual({ valide: true, valeur: 0 })
    })

    it("refuse une entrée non numérique (finding R13)", () => {
      expect(lireQuantite("abc")).toEqual({ valide: false })
    })

    it("refuse une quantité négative", () => {
      expect(lireQuantite("-1")).toEqual({ valide: false })
    })

    it("refuse une quantité non entière, comme le fait le serveur de publication", () => {
      expect(lireQuantite("2.5")).toEqual({ valide: false })
    })
  })

  describe("compterDeclinaisons", () => {
    it("compte une seule déclinaison quand ni couleur ni taille n'est renseignée", () => {
      expect(compterDeclinaisons([], [])).toBe(1)
    })

    it("croise couleurs et tailles pour plusieurs déclinaisons", () => {
      // L'exemple du brief : 2 couleurs x 2 tailles = 4 déclinaisons.
      expect(compterDeclinaisons(["rouge", "bleu"], ["M", "L"])).toBe(4)
    })

    it("compte au moins une déclinaison même si un seul des deux axes est renseigné", () => {
      expect(compterDeclinaisons(["rouge", "bleu", "vert"], [])).toBe(3)
    })
  })

  describe("calculerStockTotal", () => {
    it("multiplie la quantité par déclinaison par le nombre de déclinaisons", () => {
      // 4 pagnes par déclinaison x 4 déclinaisons (2 couleurs, 2 tailles) = 16.
      expect(calculerStockTotal(4, 4)).toBe(16)
    })

    it("rend zéro quand la quantité par déclinaison est nulle", () => {
      expect(calculerStockTotal(0, 4)).toBe(0)
    })
  })

  describe("texteStock", () => {
    it("annonce juste la quantité pour une seule déclinaison", () => {
      expect(texteStock({ valide: true, valeur: 3 }, 1)).toBe("3 en stock")
    })

    it("détaille le calcul pour plusieurs déclinaisons", () => {
      expect(texteStock({ valide: true, valeur: 4 }, 4)).toBe(
        "4 par déclinaison × 4 déclinaisons = 16 en stock"
      )
    })

    it("annonce zéro en stock plutôt que de masquer une quantité nulle", () => {
      expect(texteStock({ valide: true, valeur: 0 }, 1)).toBe("0 en stock")
    })

    it("signale une entrée invalide au lieu d'annoncer un stock (finding R13)", () => {
      expect(texteStock({ valide: false }, 4)).toBe(
        "Quantité invalide : entrez un nombre entier positif ou nul."
      )
    })
  })
})
