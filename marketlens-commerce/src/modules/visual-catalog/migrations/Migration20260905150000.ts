import { Migration } from "@medusajs/framework/mikro-orm/migrations";

type Row = {
  id: string;
  source_image_url: string;
  source_image_id: string | null;
};

/**
 * Corrige `Migration20260905143000` : ce rattrapage-là extrayait la clé de
 * fichier directement depuis `source_image_url` par un `substring` SQL, sans
 * la décoder. Or `getUploadFileUrl` (fournisseur de fichiers local, voir
 * node_modules/@medusajs/file-local/dist/services/local-file.js:48-52)
 * construit cette URL avec `new URL(...).href`, qui pourcent-encode le
 * chemin — alors que la clé stockée par le module File est brute
 * (`file.key`, node_modules/@medusajs/file/dist/services/file-module-service.js:20).
 * Dès qu'un nom de fichier porte un espace ou un accent (courant sur un
 * corpus francophone), le `substring` capture donc la forme ENCODÉE, et
 * `getAsBuffer` — qui fait un `readFile` sans décodage — échoue en ENOENT.
 *
 * Constaté sur la base de développement : 1 des 30 lignes remplies par
 * `Migration20260905143000` porte une valeur encodée
 * (`1787254368755-Tenue%20Hommes.jpg`) qui ne correspond à aucun fichier
 * réel de `static/` (le fichier s'appelle `1787254368755-Tenue Hommes.jpg`).
 *
 * Cette migration est écrite en TypeScript plutôt qu'en SQL pur : un
 * décodage `%XX` en SQL serait fragile, `decodeURIComponent` est exact.
 *
 * Portée, comme la migration précédente : bornée à `like '%/static/%'`, ce
 * qui exclut les fournisseurs distants dont l'URL ne dit rien de la clé.
 *
 * Idempotente : rejouée sur une base déjà correcte, elle ne réécrit aucune
 * ligne (comparaison avant écriture).
 *
 * Robuste : si `decodeURIComponent` lève sur une valeur mal formée (URL
 * corrompue), la migration ne plante pas — elle journalise un avertissement
 * et laisse la ligne à `null` plutôt que d'y garder une clé fausse que
 * `getAsBuffer` accepterait en silence avant d'échouer. Une ligne non
 * rattrapée produit un avertissement français propre pour la commerçante à
 * l'usage ; une migration qui plante bloque le déploiement.
 */
export class Migration20260905150000 extends Migration {

  override async up(): Promise<void> {
    const rows = await this.execute(
      `select "id", "source_image_url", "source_image_id"
         from "visual_catalogue"
        where "source_image_url" like '%/static/%';`
    ) as unknown as Row[];

    for (const row of rows) {
      const match = row.source_image_url.match(/\/static\/(.*)$/);
      if (!match) {
        continue;
      }

      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(match[1]);
      } catch {
        console.warn(
          `[Migration20260905150000] source_image_url illisible pour le catalogue ${row.id} ` +
          `(${row.source_image_url}) : source_image_id laissé à null, la photo d'origine ` +
          `restera indisponible pour ce catalogue.`
        );
        if (row.source_image_id !== null) {
          await this.execute(
            `update "visual_catalogue" set "source_image_id" = null where "id" = ?;`,
            [row.id]
          );
        }
        continue;
      }

      if (row.source_image_id === decodedKey) {
        continue;
      }

      await this.execute(
        `update "visual_catalogue" set "source_image_id" = ? where "id" = ?;`,
        [decodedKey, row.id]
      );
    }
  }

  /**
   * Ne défait QUE ce que `up()` peut avoir écrit : les lignes dont
   * l'identifiant est exactement la clé décodée déductible de leur URL
   * locale. Comme pour `Migration20260905143000`, un catalogue créé par le
   * fournisseur local après cette migration porte un identifiant de la même
   * forme et sera donc lui aussi remis à `null` — c'est le sens même d'un
   * retour arrière ici, pas une perte : la valeur reste déductible de
   * `source_image_url`, jamais touchée.
   */
  override async down(): Promise<void> {
    const rows = await this.execute(
      `select "id", "source_image_url", "source_image_id"
         from "visual_catalogue"
        where "source_image_url" like '%/static/%'
          and "source_image_id" is not null;`
    ) as unknown as Row[];

    for (const row of rows) {
      const match = row.source_image_url.match(/\/static\/(.*)$/);
      if (!match) {
        continue;
      }

      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(match[1]);
      } catch {
        continue;
      }

      if (row.source_image_id === decodedKey) {
        await this.execute(
          `update "visual_catalogue" set "source_image_id" = null where "id" = ?;`,
          [row.id]
        );
      }
    }
  }

}
