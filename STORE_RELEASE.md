# Publication Chrome Web Store

## Avant publication

- Verifier que `manifest.json` porte la bonne version.
- Recharger l'extension non empaquetee dans Chrome et tester une table Roll20.
- Generer le zip Web Store depuis `integrations/roll20-rollcodex` : `./scripts/package-extension.ps1 -Channel store`.
- Importer le zip produit dans le Chrome Web Store Developer Dashboard.

Le canal `store` nettoie le paquet avant zip : l'extension ouvre `https://rollcodex.app`, retire les hosts locaux et ne garde que `https://rollcodex.app/*`, `https://app.roll20.net/*` et `https://*.supabase.co/*`. Le canal `dev` garde les hosts locaux pour les tests non empaquetes.

## Mise a jour automatisee depuis GitHub Actions

Le depot de l'extension contient le workflow `.github/workflows/chrome-webstore-release.yml`. Il construit le paquet store, verifie que le zip ne contient plus les hosts locaux, archive le zip comme artefact GitHub Actions, puis peut l'uploader et le soumettre au Chrome Web Store.

Secrets GitHub requis dans le depot `roll20-rollcodex` :

- `CHROME_EXTENSION_ID` : identifiant de l'extension dans le Chrome Web Store.
- `CHROME_CLIENT_ID` : client OAuth Google Cloud autorise pour l'API Chrome Web Store.
- `CHROME_CLIENT_SECRET` : secret du client OAuth.
- `CHROME_REFRESH_TOKEN` : refresh token OAuth avec le scope `https://www.googleapis.com/auth/chromewebstore`.

Declencheurs :

- `workflow_dispatch` avec `dry_run: true` : construit et verifie le zip, sans appel au Store.
- `workflow_dispatch` avec `tag`, `dry_run: false`, `publish: false` : uploade le zip sur la fiche Chrome Web Store sans soumettre la publication.
- `workflow_dispatch` avec `tag`, `dry_run: false`, `publish: true` : uploade puis soumet la version.
- push d'un tag `vX.Y.Z` : uploade puis soumet automatiquement la version.

Le tag doit toujours correspondre a la version du manifest. Exemple : `manifest.json` en `0.3.2` se publie avec le tag `v0.3.2`.

Pour une premiere fiche Web Store, creer d'abord l'item dans le Developer Dashboard afin d'obtenir `CHROME_EXTENSION_ID`, renseigner les assets et la confidentialite, puis laisser le workflow gerer les mises a jour suivantes.

## Points a fournir dans le Web Store

- Nom : `RollCodex Roll20`
- Description courte : `Connecte une table Roll20 a RollCodex.`
- Categorie suggeree : `Productivity`.
- Langue principale : `French`.
- URL de confidentialite : `https://rollcodex.app/confidentialite`.
- Description detaillee :

```text
RollCodex Roll20 connecte une table Roll20 a un registre RollCodex.

L'extension ajoute un panneau local dans Roll20 pour jumeler la table avec RollCodex, envoyer les messages visibles du chat et activer une auto-capture locale apres activite. Les captures sont relues dans RollCodex avant import et restent limitees aux donnees visibles dans Roll20.

RollCodex ne deduit pas de narration, de scene ou d'intention MJ absente des logs. Roll20 ne fournit pas les objets Actor/Item natifs de Foundry a l'extension : le mapping repose donc sur les speakers et textes visibles dans le chat.
```

- Justification des permissions :
  - `storage` : conserver la liaison locale et l'etat d'auto-capture.
  - `tabs` : retrouver l'onglet Roll20 ouvert pendant le jumelage.
  - `https://app.roll20.net/*` : injecter le panneau RollCodex dans la table Roll20.
  - `https://rollcodex.app/*` : finaliser le jumelage depuis l'application RollCodex.
  - `https://*.supabase.co/*` : envoyer les captures VTT vers l'endpoint RollCodex.

## Confidentialite a declarer

- Donnees collectees : contenu des messages Roll20 visibles au moment de l'envoi, speakers detectes, metriques derivees de chat, identifiants techniques de connexion RollCodex.
- Finalite : connecter Roll20 a RollCodex et transmettre des captures VTT vers le registre choisi par l'utilisateur.
- Stockage local extension : liaison de connexion, secret de connexion, reglages du panneau et de l'auto-capture.
- Partage : donnees envoyees uniquement vers l'endpoint RollCodex associe a la connexion jumellee.
- Usage publicitaire : aucun.

## Assets requis

- Icone extension : incluse dans `icons/` et referencee par le manifest.
- Captures d'ecran Web Store : a produire depuis une vraie session Roll20 + RollCodex avant soumission finale.
- Tuile promotionnelle : optionnelle pour une premiere soumission, mais recommandee avant publication publique.

## Limite produit

Roll20 ne fournit pas les objets Actor/Item natifs de Foundry a l'extension. Le mapping Roll20 reste base sur les speakers et les textes visibles dans le chat.
