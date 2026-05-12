# Publication Chrome Web Store

## Avant publication

- Verifier que `manifest.json` porte la bonne version.
- Recharger l'extension non empaquetee dans Chrome et tester une table Roll20.
- Generer le zip avec `./scripts/package-extension.ps1`.
- Importer le zip produit dans le Chrome Web Store Developer Dashboard.

## Points a fournir dans le Web Store

- Nom : `RollCodex Roll20`
- Description courte : `Connecte une table Roll20 a RollCodex.`
- Justification des permissions :
  - `storage` : conserver la liaison locale et l'etat d'auto-capture.
  - `tabs` : retrouver l'onglet Roll20 ouvert pendant le jumelage.
  - `https://app.roll20.net/*` : injecter le panneau RollCodex dans la table Roll20.
  - `https://*.supabase.co/*` : envoyer les captures VTT vers l'endpoint RollCodex.

## Limite produit

Roll20 ne fournit pas les objets Actor/Item natifs de Foundry a l'extension. Le mapping Roll20 reste base sur les speakers et les textes visibles dans le chat.