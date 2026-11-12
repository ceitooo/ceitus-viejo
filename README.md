# Ceitus

Bot de Discord del servidor de CeitoTweaks.

## Qué hace

- **Moderación y seguridad:** `/warn`, `/jail`, `/purga`, `/lock` y `/unlock`, `/slowmode`, `/blacklist`, `/antiraid` y `/seguridad`, más anti-nuke, filtro de estafas y bloqueo de bots agregados de golpe.
- **Comunidad:** bienvenidas, boosts, niveles y roles por nivel (`/rank`, `/nivelrol`), perfiles, invitaciones (`/misinvitaciones`), sorteos (`/sorteo`), recordatorios y mensajes fijos.
- **CeitoTweaks:** `/ceitotweaksupdate` y `/changelog` para anunciar versiones, `/milicencia`, `/faq`, la tienda (`/tienda`), el stock y las keys (`/stock`, `/regenerarstock`, `/eliminarkey`, `/vaciarstock`, `/probarkey`) y el chequeo de reseñas.
- **Streams:** avisa cuando alguien del servidor sale en vivo (`/stream`).
- **Diversión:** imágenes y GIFs (`/petpet`, `/deepfry`, `/magik`, `/wanted`, `/wasted`, `/rip`, `/triggered`, `/rainbow`, `/shipeo`) y reacciones (`/hug`, `/pat`, `/kiss`, `/slap`), además de `/8ball`, `/dado`, `/moneda`, `/spin`, `/aura`, `/cat` y `/traducir`.

## Configuración

1. Copiá `.env.example` a `.env` y completalo.
2. `npm install`
3. `npm start` — al arrancar, el bot registra solo sus comandos de barra.

`npm run deploy-commands` registra los comandos sin arrancar el bot.

Los datos (niveles, stock, sorteos…) se guardan en SQLite dentro de `data/`.
