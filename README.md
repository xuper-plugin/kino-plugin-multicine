# MultiCine

Plugin de [Kino](https://kinotvapp.github.io/kino-plugins/) para ver películas y series con enlaces de muchas fuentes a la vez.

El catálogo (pósters, sinopsis, géneros, capítulos) viene de TMDB. Los enlaces los buscan, en paralelo, los scrapers de un
repositorio de Nuvio: Kino los instala por su cuenta, sin que tengas que importar nada, y MultiCine ordena y junta lo que
encuentran en un solo menú **Servidor**, con la mejor copia primero y el resto como alternativas.

Es un **experimento** y también el ejemplo de cómo se usa `kino.nuvio`:
[Plugins que usan scrapers de Nuvio](https://kinotvapp.github.io/kino-plugins/nuvio-plugins/).

## Instalarlo

En Kino 0.9.71 o más nuevo: Ajustes ▸ Plugins ▸ **Agregar plugin** y escribe

```
xuper-plugin/kino-plugin-multicine
```

Kino muestra qué permisos pide (instalar y usar scrapers de Nuvio del repositorio que indica; reproducir video desde cualquier
servidor) y tú decides si lo instalas.

## Qué hace

- Inicio, Categorías y una sección propia con pestañas de **Cine** y **Series**.
- Elige los scrapers que mejor funcionan (prefiere los que hablan tu idioma y los que respondieron bien hace poco), los
  pregunta por tandas y descarta los enlaces que son avances o cuyo servidor no responde.
- Ajustes: cuántas filas en Inicio, cuántos scrapers usar, calidad preferida.

## Cómo funciona

`kino-plugin.json` declara la capacidad `nuvio` y el repositorio de scrapers en `nuvioRepos`. `plugin.js` llama a
`kino.nuvio.available`, `use` y `streams`. Para usar otro repositorio de Nuvio, cambia `nuvioRepos` en el manifiesto y la
constante `REPO` de `plugin.js`, y sube la `version`.

## Desarrollo

Necesitas Node 18 o más nuevo y el kit [kino-plugin-sdk](https://github.com/kinotvapp/kino-plugin-sdk):

```
git clone https://github.com/kinotvapp/kino-plugin-sdk
node kino-plugin-sdk/sdk/validate.mjs .
KINO_NUVIO_FIXTURE=kino-plugin-sdk/fixtures/nuvio.json node kino-plugin-sdk/sdk/run.mjs . home
```

El kit no tiene scrapers: responde `kino.nuvio` desde una fixture. Que los scrapers de verdad respondan solo se prueba en
Kino.

## Aviso

Quien escribe un plugin es responsable de él; Kino solo lo lista. Los scrapers y los sitios que consultan son de terceros.
Úsalo únicamente para lo que ya tienes derecho a ver.
