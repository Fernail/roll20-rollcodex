# RollCodex Roll20

Extension Chrome pour connecter une table Roll20 a RollCodex.

RollCodex aide les MJ a transformer des donnees VTT relues en activite de campagne, tendances et imports exploitables dans leur registre RollCodex.

## Installation depuis le Chrome Web Store

Fiche publique : `https://chromewebstore.google.com/detail/rollcodex-roll20/janfigfnhmgimnbeklajfhaccgcngmpc`

1. Installer l'extension depuis la fiche Chrome Web Store.
2. Ouvrir une table Roll20 dans Chrome.
3. Utiliser le panneau RollCodex injecte dans la table pour jumeler le registre.

## Installation locale

1. Ouvrir `chrome://extensions`.
2. Activer le mode developpeur.
3. Cliquer sur `Charger l'extension non empaquetee`.
4. Selectionner le dossier `integrations/roll20-rollcodex`.
5. Recharger l'onglet Roll20 et l'onglet RollCodex.

## Compatibilite

- Navigateur verifie : Chrome desktop.
- Roll20 : table ouverte dans `https://app.roll20.net/`.
- Extension RollCodex Roll20 : 0.3.3.

## Utilisation

1. Ouvrir la table Roll20.
2. Utiliser le panneau RollCodex injecte dans la table.
3. Cliquer sur `Connecter`.
4. Choisir le registre, le systeme, la campagne et la table dans RollCodex.
5. Revenir a Roll20.
6. Cliquer sur `Envoyer` pour transmettre les messages visibles du chat a RollCodex, ou laisser l'auto-capture active apres une activite chat.
7. Relire puis importer les donnees dans RollCodex.

Le flux extension ne demande pas de script Roll20 installe ni de commande `!rollcodex` dans le chat. Les anciennes commandes appartiennent au Mod Roll20 historique et ne sont pas requises pour tester l'extension Chrome.

L'extension envoie des captures VTT a relire. RollCodex ne transforme pas automatiquement ces donnees en narration et ne pretend pas deduire un contexte de jeu absent des logs.

## Fonctionnalites

- Jumelage depuis la table Roll20 vers RollCodex, avec choix du registre, du systeme, de la campagne et de la table.
- Envoi manuel des messages visibles du chat.
- Auto-capture locale apres activite chat, avec intervalle de securite pour eviter les envois trop rapproches.
- Panneau live local avec compteurs de messages, jets, critiques, degats, soins et joueur le plus actif selon le chat visible.
- Indices de mapping Roll20 joints aux captures : speakers detectes, types d'action approximatifs, limites du DOM Roll20.

## Limites actuelles

- La capture s'appuie sur les messages visibles/lisibles dans le DOM Roll20.
- Les changements d'interface Roll20 peuvent necessiter une adaptation des selecteurs.
- Roll20 ne fournit pas a l'extension les objets Actor/Item natifs de Foundry. Le mapping reste donc base sur les speakers et textes visibles.
- Le paquet Chrome Web Store se genere avec `scripts/package-extension.ps1 -Channel store`.
- Les mises a jour Chrome Web Store peuvent etre automatisees via `.github/workflows/chrome-webstore-release.yml` apres configuration des secrets Google dans le depot de l'extension.

## Support

Les questions et incidents peuvent etre ouverts depuis le depot RollCodex principal.
