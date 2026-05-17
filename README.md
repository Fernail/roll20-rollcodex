# RollCodex Roll20

Extension navigateur pour connecter une table Roll20 a RollCodex.

RollCodex aide les MJ a transformer des donnees VTT relues en activite de campagne, tendances et imports exploitables dans leur registre RollCodex.

## Installation depuis le Chrome Web Store

Fiche publique : `https://chromewebstore.google.com/detail/rollcodex-roll20/janfigfnhmgimnbeklajfhaccgcngmpc`

1. Installer l'extension depuis la fiche Chrome Web Store.
2. Ouvrir une table Roll20 dans un navigateur cible.
3. Utiliser le panneau RollCodex injecte dans la table pour jumeler le registre.

## Installation locale

Pour tester RollCodex en local sur `localhost:5173`, generer le canal dev :

```powershell
./scripts/package-extension.ps1 -Channel dev -OutputDirectory dist
```

Variantes locales :

```powershell
./scripts/package-extension.ps1 -Channel dev -OutputDirectory dist
./scripts/package-extension.ps1 -Channel firefox-dev -OutputDirectory dist
./scripts/package-extension.ps1 -Channel safari-dev -OutputDirectory dist
```

1. Ouvrir la page extensions du navigateur : `chrome://extensions`, `opera://extensions`, `edge://extensions` ou `brave://extensions`.
2. Activer le mode developpeur.
3. Cliquer sur `Charger l'extension non empaquetee`.
4. Selectionner le dossier adapte : `dist/unpacked-dev`, `dist/unpacked-firefox-dev` ou `dist/unpacked-safari-dev`.
5. Recharger l'onglet Roll20 et l'onglet RollCodex.

Ne gardez pas deux variantes chargees dans le meme navigateur en meme temps.

## Compatibilite

- Navigateurs cibles : Chrome, Edge, Brave, Opera, Firefox et Safari desktop.
- Roll20 : table ouverte dans `https://app.roll20.net/`.
- Extension RollCodex Roll20 : 0.4.0.

Firefox et Safari demandent un paquet dedie : leurs manifests et leurs scripts de fond ne sont pas strictement identiques a Chromium. Le code runtime evite les appels Chrome-only en utilisant `chrome` ou `browser` selon l'interface exposee.

## Utilisation

1. Ouvrir la table Roll20.
2. Utiliser le panneau RollCodex injecte dans la table.
3. Cliquer sur `Connecter`.
4. Choisir le registre, le systeme, la campagne et la table dans RollCodex.
5. Revenir a Roll20.
6. Cliquer sur `Envoyer` pour transmettre les messages visibles du chat a RollCodex, ou laisser l'auto-capture active apres une activite chat.
7. Relire puis importer les donnees dans RollCodex.

Le flux extension ne demande pas de script Roll20 installe ni de commande `!rollcodex` dans le chat. Les anciennes commandes appartiennent au Mod Roll20 historique et ne sont pas requises pour tester l'extension navigateur.

L'extension envoie des captures VTT a relire. RollCodex ne transforme pas automatiquement ces donnees en narration et ne pretend pas deduire un contexte de jeu absent des logs.

## Fonctionnalites

- Jumelage depuis la table Roll20 vers RollCodex, avec choix du registre, du systeme, de la campagne et de la table.
- Envoi manuel des messages visibles du chat.
- Auto-capture locale apres activite chat, avec intervalle de securite pour eviter les envois trop rapproches.
- Panneau live local avec kikimeter base sur les mesures du registre RollCodex cible.
- Indices de mapping Roll20 joints aux captures : speakers detectes, mappings RollCodex deja confirmes, types d'action approximatifs, limites du DOM Roll20.
- Panneau lecteur pour les joueurs : si le MJ a connecte la table, chaque joueur ayant l'extension voit un panneau en lecture seule (statut, contexte, kikimeter avec selecteur local). Aucune donnee n'est envoyee depuis le navigateur des joueurs.

## Panneau lecteur (joueurs)

Pour que les joueurs voient le panneau RollCodex sur leur table Roll20 :

1. Le MJ installe l'extension et connecte la table (jumelage RollCodex).
2. Chaque joueur installe la meme extension Chrome Web Store dans son navigateur.
3. A l'ouverture de la table, l'extension detecte automatiquement que le joueur n'est pas le MJ et bascule en mode lecteur : seul le bandeau statut, le contexte de la table et le kikimeter (avec selecteur de mesure local) sont affiches. Les boutons Lier, Envoyer, Auto et Fin sont masques.
4. Le panneau lecteur demande la session au MJ via un whisper Roll20 technique, puis se met a jour quand le MJ envoie une capture ou via un heartbeat regulier (5 min). Aucune capture chat n'est envoyee depuis le navigateur du joueur.

Limite : un joueur sans l'extension ne voit aucun panneau (limitation Chrome : une extension ne peut pas s'injecter dans un navigateur ou elle n'est pas installee).

## Limites actuelles

- La capture s'appuie sur les messages visibles/lisibles dans le DOM Roll20.
- Les changements d'interface Roll20 peuvent necessiter une adaptation des selecteurs.
- Roll20 ne fournit pas a l'extension les objets Actor/Item natifs de Foundry. Le mapping reste donc base sur les speakers et textes visibles.
- Le paquet local Chromium localhost se genere avec `scripts/package-extension.ps1 -Channel dev`.
- Le paquet local Firefox localhost se genere avec `scripts/package-extension.ps1 -Channel firefox-dev`.
- Le paquet local Safari localhost se genere avec `scripts/package-extension.ps1 -Channel safari-dev`.
- Le paquet Chrome Web Store se genere avec `scripts/package-extension.ps1 -Channel store` apres validation locale.
- Les paquets publication Firefox et Safari se generent avec `scripts/package-extension.ps1 -Channel firefox-store` et `scripts/package-extension.ps1 -Channel safari-store`.
- Les mises a jour Chrome Web Store peuvent etre automatisees via `.github/workflows/chrome-webstore-release.yml` apres configuration des secrets Google dans le depot de l'extension.

## Support

Les questions et incidents peuvent etre ouverts depuis le depot RollCodex principal.
