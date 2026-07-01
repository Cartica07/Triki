# Triki Online

Triki (3 en línea) multijugador en tiempo real. Sin backend propio: usa
**Firebase Realtime Database** como "servidor", así que todo el proyecto
son archivos estáticos (`index.html`, `style.css`, `app.js`), igual que
tu juego del tigre.

## Cómo funciona

1. Un jugador entra al sitio y toca **Crear partida** → se genera un código
   de 4 letras y se crea una "sala" en la base de datos.
2. Comparte el código (o el link `tusitio.vercel.app/?code=ABCD`).
3. El otro jugador lo ingresa en **Unirse a partida**.
4. En el momento en que se une, se tira una moneda al azar: quien la gana
   arranca poniendo X. Recién ahí empieza la partida.
5. Ambos ven el tablero en tiempo real y juegan por turnos, tocando el
   recuadro donde quieren jugar. Cada jugada se sincroniza vía Firebase.

No hay login: cada navegador genera un `clientId` random guardado en
`localStorage`, que es lo que identifica a cada jugador dentro de la sala.

### El tablero

El fondo (`assets/board-bg.jpg`) es una imagen fija con las líneas del
triki ya dibujadas encima. El juego **no dibuja ninguna línea**: solo
posiciona 9 zonas táctiles invisibles y las marcas de X/O exactamente
sobre esas líneas, usando coordenadas medidas en porcentaje (ver las
constantes `GRID_X` / `GRID_Y` al principio de `app.js`).

Si en algún momento cambiás la imagen de fondo por otra con las líneas
en otro lugar, hay que volver a medir esas coordenadas — decime y te
ayudo a recalcularlas.

## 1. Crear el proyecto de Firebase

1. Andá a https://console.firebase.google.com/ → **Agregar proyecto**.
2. Ponele un nombre (ej. `triki-online`) y seguí los pasos (no hace falta
   Google Analytics, podés desactivarlo).
3. Dentro del proyecto, andá a **Compilación → Realtime Database** →
   **Crear base de datos**.
   - Elegí la ubicación (cualquiera cercana está bien, ej. `us-central1`).
   - Empezá en **modo de prueba** (test mode) — después ajustamos las reglas.
4. Andá a **Configuración del proyecto** (ícono de tuerca) → en la sección
   **Tus apps**, tocá el ícono `</>` (Web) para registrar una app.
   - No hace falta Firebase Hosting.
   - Te va a mostrar un objeto `firebaseConfig` — copialo.

## 2. Completar `firebase-config.js`

Pegá los valores que copiaste en el archivo `firebase-config.js`:

```js
const FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "triki-online-xxxx.firebaseapp.com",
  databaseURL: "https://triki-online-xxxx-default-rtdb.firebaseio.com",
  projectId: "triki-online-xxxx",
  storageBucket: "triki-online-xxxx.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

> Estos valores **no son secretos** (son la config pública del cliente),
> así que no hay problema en que queden en el repo público de GitHub.
> Lo que sí protege tus datos son las **reglas** del paso siguiente.

## 3. Configurar las reglas de la base de datos

En Firebase Console → Realtime Database → pestaña **Reglas**, reemplazá
por esto y publicá:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['board','turn','status','players'])"
      }
    },
    ".read": false,
    ".write": false
  }
}
```

Esto permite leer/escribir únicamente dentro de `rooms/*` (no el resto de
la base) y exige que cada sala tenga la forma esperada. Es una regla
abierta (sin autenticación) — perfecta para jugar con amigos por link,
pero cualquiera que adivine o tenga el código de 4 letras podría
teóricamente escribir en esa sala puntual. Para un juego casual entre
amigos es más que suficiente.

## 4. Probar en local

Como el proyecto usa `fetch`/módulos de Firebase, abrilo con un servidor
local en vez de doble-click al HTML (para evitar restricciones de CORS):

```bash
npx serve .
# o
python3 -m http.server 5500
```

Abrí la URL en dos pestañas (o una en el celular) para probar de los dos
lados.

## 5. Subir a GitHub y desplegar en Vercel

Igual que con Vence al Tigre:

```bash
git init
git add .
git commit -m "Triki online"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/triki-online.git
git push -u origin main
```

Y en [vercel.com](https://vercel.com):

1. **Add New → Project** → importá el repo.
2. Framework Preset: **Other** (es HTML estático, no necesita build).
3. Deploy.

Listo — el link que te da Vercel es el que compartís, y agregando
`?code=XXXX` al final se autocompleta el campo del código para el que
se une.

## Posibles mejoras a futuro

- Detectar si un jugador se desconecta (`onDisconnect()` de Firebase) y
  avisarle al otro.
- Reglas más estrictas validando que cada jugador solo pueda escribir
  cuando es su turno.
- Chat simple entre los dos jugadores dentro de la sala.
- Historial/marcador de partidas ganadas en la sesión.
