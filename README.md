# GoldenApple Extension Engine

Moteur navigateur GoldenApple sous forme d'extension Chrome Manifest V3.

Cette extension analyse les pages de jeu supportees, envoie les resultats au backend GoldenApple et recoit les commandes depuis l'application web via Socket.IO.

## Role dans l'architecture

```text
Extension Chrome
  <-> Backend Express + Socket.IO
  <-> Application web Netlify
```

L'extension n'est pas deployee sur Netlify. Elle doit etre chargee dans Chrome ou publiee comme extension.

Le backend, lui, doit etre deploye sur une URL publique. L'extension utilise cette URL dans son champ `Backend URL`.

## Structure

```text
background.js              # service worker central, pairing, Socket.IO, relais backend
content.js                 # pont avec les pages ciblees
popup.html                 # interface de configuration extension
popup.js                   # logique popup
manifest.json              # configuration Chrome Manifest V3
communication/             # modules auth, pairing, sync, websocket
core/                      # detection, analyse, prediction
```

## Installation locale dans Chrome

1. Ouvrir `chrome://extensions`.
2. Activer `Developer mode`.
3. Cliquer sur `Load unpacked`.
4. Selectionner le dossier `Goldenapple-script`.
5. Ouvrir le popup de l'extension.
6. Renseigner l'URL du backend public ou local.
7. Coller le `client_id` obtenu depuis l'application web.
8. Cliquer sur `Pair + connecter`.

## Configuration backend

En developpement local :

```text
Backend URL: http://localhost:3000
```

En production :

```text
Backend URL: https://your-backend-domain.example.com
```

Ne pas utiliser l'URL Netlify ici si Netlify ne sert que le frontend. L'extension doit joindre le backend API/Socket.IO.

## Fichiers a ne pas publier

Ne commit pas :

- archives zip generees ;
- builds temporaires ;
- cles privees ;
- captures ou donnees utilisateur ;
- fichiers locaux de test.

## Avant publication GitHub

Verifier :

1. Aucun secret dans le code.
2. Aucun token ou `client_id` personnel dans le repo.
3. `manifest.json` contient seulement les permissions necessaires.
4. Le backend public fonctionne sur `/api/status`.
5. Le pairing fonctionne avec une URL backend propre.
