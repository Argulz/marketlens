import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Rattrape les catalogues existants : remplit `source_image_id` pour les
 * lignes dont la photo d'origine a été déposée par le fournisseur de
 * fichiers LOCAL.
 *
 * Pourquoi une migration séparée, et non une retouche de
 * `Migration20260905105211` : celle-là est déjà appliquée, son `up()` ne
 * sera pas rejoué. Une base à jour resterait sans données.
 *
 * Pourquoi ce n'est PAS le couplage que la colonne existe pour supprimer.
 * La colonne a été ajoutée précisément parce que déduire la clé de fichier
 * de `source_image_url` ne marche qu'avec le fournisseur local, et casserait
 * avec un fournisseur distant dont les URLs ne portent pas la clé (voir le
 * commentaire du modèle). Cette déduction-ci est ponctuelle et bornée : elle
 * s'applique UNE fois, à des lignes dont la clause `like '%/static/%'`
 * démontre qu'elles viennent du fournisseur local — dont on sait, pour
 * l'avoir lu, que `url = backend_url + key` et que `id = key`
 * (node_modules/@medusajs/file-local/dist/services/local-file.js, `upload` ;
 * node_modules/@medusajs/file/dist/services/file-module-service.js:20). Ce
 * n'est pas une déduction à l'exécution : le code ne redérive jamais la clé
 * depuis l'URL, il lit la colonne.
 *
 * La clause `like` est essentielle et non décorative : elle laisse
 * intactes les lignes d'un autre fournisseur, dont l'URL ne dit rien de la
 * clé, plutôt que d'y écrire une valeur fausse que `getAsBuffer`
 * accepterait en silence avant d'échouer.
 *
 * Sans ce rattrapage, aucun des 31 catalogues de la base de développement ne
 * peut être réannoté : la correction des prix rendrait un avertissement
 * « la photo d'origine n'est plus disponible » sur chacun d'eux, y compris
 * pendant une démonstration.
 */
export class Migration20260905143000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`update "visual_catalogue"
   set "source_image_id" = substring("source_image_url" from '/static/(.*)$')
 where "source_image_id" is null
   and "source_image_url" like '%/static/%';`);
  }

  /**
   * Ne défait QUE ce que `up()` a écrit : les lignes dont l'identifiant est
   * exactement la clé déductible de leur URL locale. Une valeur posée
   * autrement (fournisseur distant, correction manuelle) n'est pas touchée.
   *
   * Limite assumée : un catalogue créé par le fournisseur local APRÈS cette
   * migration porte un identifiant de la même forme, et sera donc lui aussi
   * remis à `null`. C'est le sens même d'un retour arrière ici — revenir à
   * l'état où ces lignes ne sont pas réannotables — et non une perte : la
   * valeur reste déductible de `source_image_url`, qui n'est jamais touchée.
   */
  override async down(): Promise<void> {
    this.addSql(`update "visual_catalogue"
   set "source_image_id" = null
 where "source_image_id" is not null
   and "source_image_url" like '%/static/%'
   and "source_image_id" = substring("source_image_url" from '/static/(.*)$');`);
  }

}
