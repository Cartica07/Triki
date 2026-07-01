// ===================================================
// TRIKI ONLINE — lógica de salas y partida
// ===================================================

const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // sin 0/O/1/I/L, evita confusiones

// "Latido" que manda el creador mientras espera rival, para poder detectar
// salas abandonadas sin depender de eventos de desconexión (que en el
// celular saltan solos al cambiar de app, dando falsos positivos).
const HEARTBEAT_INTERVAL_MS = 15 * 1000; // cada cuánto avisa "sigo acá"
// Antes eran 60s, pero cuando el creador comparte el link (WhatsApp, etc.)
// el navegador pasa a segundo plano y los setInterval se pausan/frenan ahí,
// así que el heartbeat se congela mientras se elige el contacto y se manda
// el mensaje. 60s se cumplía fácil en ese lapso y borraba la sala por una
// falsa alarma. 3 minutos da margen real para ese flujo sin tardar
// demasiado en detectar un abandono genuino.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// Margen de gracia antes de cerrar la sala cuando el rival deja de figurar
// como presente. Evita que un simple refresh (F5) —que desconecta y
// reconecta el socket en menos de un segundo— se confunda con un cierre real.
const PRESENCE_GRACE_MS = 5 * 1000;

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

// Límites de la grilla medidos sobre assets/board-bg.jpg (en % del contenedor)
const GRID_X = [22.3, 40.7, 61.1, 80.4];
const GRID_Y = [20.6, 30.0, 40.4, 51.9];

function getCellBox(i){
  const row = Math.floor(i / 3);
  const col = i % 3;
  const left = GRID_X[col];
  const right = GRID_X[col + 1];
  const top = GRID_Y[row];
  const bottom = GRID_Y[row + 1];
  return {
    left, top,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2
  };
}

// ---------- estado local ----------
let db = null;
let roomRef = null;
let currentRoomCode = null;
let mySymbol = null; // 'X' | 'O'
let clientId = getOrCreateClientId();
let renderedMarks = new Set();
let heartbeatTimer = null;
let presenceRef = null;        // rooms/{code}/presence/{clientId} — mi nodo de presencia
let presenceGraceTimer = null; // cuenta regresiva antes de dar al rival por desconectado

// ---------- referencias DOM ----------
const views = {
  home: document.getElementById('view-home'),
  waiting: document.getElementById('view-waiting'),
  game: document.getElementById('view-game'),
};
const boardLayer = document.getElementById('board');
const winLineEl = document.getElementById('win-line');
const btnCrear = document.getElementById('btn-crear');
const formUnirse = document.getElementById('form-unirse');
const inputCode = document.getElementById('input-code');
const homeError = document.getElementById('home-error');
const roomCodeDisplay = document.getElementById('room-code-display');
const btnCancelWait = document.getElementById('btn-cancel-wait');
const btnShare = document.getElementById('btn-share');
const roomCodeTag = document.getElementById('room-code-tag');
const turnIndicator = document.getElementById('turn-indicator');
const gameResult = document.getElementById('game-result');
const resultText = document.getElementById('result-text');
const btnRematch = document.getElementById('btn-rematch');
const btnLeave = document.getElementById('btn-leave');
const connStatus = document.getElementById('connection-status');
const btnRestartMatch = document.getElementById('btn-restart-match');

// ===================================================
// Arranque
// ===================================================
init();

function init(){
  buildCells();

  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    connStatus.textContent = 'conectado';
    listenConnectionState();
  }catch(err){
    console.error(err);
    connStatus.textContent = 'sin conexión a Firebase — revisá firebase-config.js';
    return;
  }

  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get('code');
  if(codeFromUrl){
    inputCode.value = codeFromUrl.toUpperCase();
  }

  btnCrear.addEventListener('click', crearPartida);
  formUnirse.addEventListener('submit', (e) => {
    e.preventDefault();
    unirsePartida(inputCode.value.trim().toUpperCase());
  });
  btnCancelWait.addEventListener('click', cancelarEspera);
  btnLeave.addEventListener('click', () => salir(true));
  btnRematch.addEventListener('click', pedirRevancha);
  btnShare.addEventListener('click', compartirLink);

  // OJO: si en algún momento agregás/sacás botones del HTML, esta guarda
  // evita que un getElementById que devuelve null tire abajo TODO el script
  // (addEventListener sobre null revienta y ninguno de los botones de arriba
  // quedaría conectado). Por eso el de reiniciar va con chequeo aparte:
  if(btnRestartMatch){
    btnRestartMatch.addEventListener('click', reiniciarPartida);
  }else{
    console.warn('No se encontró el botón #btn-restart-match en el HTML — revisá el id.');
  }

  if(codeFromUrl && codeFromUrl.trim().length === 4){
    unirsePartida(codeFromUrl.trim().toUpperCase());
  }
}

function buildRoomLink(code){
  return location.origin + location.pathname + '?code=' + code;
}

async function compartirLink(){
  if(!currentRoomCode) return;
  // Reseteamos el heartbeat justo antes de que el navegador pase a segundo
  // plano por el share sheet, así el reloj de "abandono" arranca de nuevo
  // desde este instante en vez de depender del último tick del setInterval.
  db.ref('rooms/' + currentRoomCode + '/heartbeat').set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
  const url = buildRoomLink(currentRoomCode);
  const shareData = {
    title: 'Triki Frente',
    text: 'Unite a mi partida de Triki (código ' + currentRoomCode + ')',
    url
  };
  try{
    if(navigator.share){
      await navigator.share(shareData);
      return;
    }
    throw new Error('no-web-share');
  }catch(err){
    if(err.name === 'AbortError') return;
    try{
      await navigator.clipboard.writeText(url);
      flashShareButton('¡Link copiado!');
    }catch(copyErr){
      flashShareButton('No se pudo copiar');
    }
  }
}

function flashShareButton(msg){
  const original = btnShare.textContent;
  btnShare.textContent = msg;
  btnShare.disabled = true;
  setTimeout(() => {
    btnShare.textContent = original;
    btnShare.disabled = false;
  }, 1500);
}

function buildCells(){
  for(let i = 0; i < 9; i++){
    const box = getCellBox(i);
    const btn = document.createElement('button');
    btn.className = 'cell';
    btn.dataset.i = i;
    btn.style.left = box.left + '%';
    btn.style.top = box.top + '%';
    btn.style.width = box.width + '%';
    btn.style.height = box.height + '%';
    btn.addEventListener('click', () => jugar(i));
    boardLayer.appendChild(btn);
  }
}

function listenConnectionState(){
  db.ref('.info/connected').on('value', (snap) => {
    connStatus.textContent = snap.val() ? 'conectado' : 'reconectando…';
  });
}

function getOrCreateClientId(){
  let id = localStorage.getItem('triki_client_id');
  if(!id){
    if(crypto.randomUUID){
      id = crypto.randomUUID();
    }else{
      const rand = Math.random().toString(36).slice(2);
      id = 'c-' + Date.now().toString(36) + '-' + rand;
    }
    localStorage.setItem('triki_client_id', id);
  }
  return id;
}

function showView(name){
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
  boardLayer.classList.toggle('active', name === 'game');
}

// ===================================================
// Crear / unirse
// ===================================================
async function crearPartida(){
  homeError.textContent = '';
  btnCrear.disabled = true;
  try{
    const code = await generarCodigoUnico();
    const room = {
      board: ["","","","","","","","",""],
      turn: null,
      status: 'waiting',
      players: { creator: clientId },
      symbols: {},
      winner: null,
      round: 0,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      heartbeat: firebase.database.ServerValue.TIMESTAMP
    };
    const ref = db.ref('rooms/' + code);
    await ref.set(room);
    entrarASala(code);
  }catch(err){
    console.error(err);
    homeError.textContent = 'No se pudo crear la partida: ' + (err.code || '') + ' ' + (err.message || err);
  }finally{
    btnCrear.disabled = false;
  }
}

async function generarCodigoUnico(){
  for(let i = 0; i < 6; i++){
    const code = randomCode();
    const snap = await db.ref('rooms/' + code).get();
    if(!snap.exists()) return code;
  }
  throw new Error('No se pudo generar un código único');
}

function randomCode(){
  let out = '';
  for(let i = 0; i < 4; i++){
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

async function unirsePartida(code){
  homeError.textContent = '';
  if(!code || code.length !== 4){
    homeError.textContent = 'Ingresá un código de 4 caracteres.';
    return;
  }
  try{
    const ref = db.ref('rooms/' + code);
    const snap = await ref.get();
    if(!snap.exists()){
      homeError.textContent = 'Ese link de invitación ya no es válido (Crea nueva partida).';
      limpiarCodigoDeUrl();
      inputCode.value = '';
      return;
    }
    const room = snap.val();

    if(room.players.creator === clientId || room.players.joiner === clientId){
      entrarASala(code);
      return;
    }

    if(room.status === 'waiting'){
      const lastSignal = room.heartbeat || room.createdAt;
      if(lastSignal && (Date.now() - lastSignal > HEARTBEAT_STALE_MS)){
        ref.remove().catch(() => {});
        homeError.textContent = 'Ese link de invitación ya no es válido (Crea nueva partida).';
        limpiarCodigoDeUrl();
        inputCode.value = '';
        return;
      }
    }

    if(room.players.joiner){
      homeError.textContent = 'Esa sala ya está completa.';
      limpiarCodigoDeUrl();
      inputCode.value = '';
      return;
    }

    const creatorStarts = Math.random() < 0.5;
    const symbols = {
      [room.players.creator]: creatorStarts ? 'X' : 'O',
      [clientId]: creatorStarts ? 'O' : 'X'
    };

    await ref.update({
      'players/joiner': clientId,
      symbols: symbols,
      status: 'playing',
      turn: 'X'
    });
    entrarASala(code);
  }catch(err){
    console.error(err);
    homeError.textContent = 'Error al unirse: ' + (err.code || '') + ' ' + (err.message || err);
  }
}

function entrarASala(code){
  currentRoomCode = code;
  roomRef = db.ref('rooms/' + code);

  // ---- presencia en tiempo real ----
  // Le decimos a Firebase: "si en algún momento se corta mi conexión de
  // verdad (cierro la pestaña, pierdo señal, mato la app), borrá mi nodo
  // de presencia". Esto lo ejecuta el SERVIDOR ni bien detecta el corte,
  // sin depender de que mi navegador alcance a avisar nada antes de morir.
  presenceRef = db.ref('rooms/' + code + '/presence/' + clientId);
  presenceRef.onDisconnect().remove();
  presenceRef.set(true);

  roomRef.on('value', onRoomUpdate);

  const url = new URL(location.href);
  url.searchParams.set('code', code);
  history.replaceState(null, '', url.pathname + url.search);
}

function cancelarEspera(){
  if(roomRef){
    roomRef.off('value', onRoomUpdate);
    db.ref('rooms/' + currentRoomCode + '/players/joiner').get().then(snap => {
      if(!snap.exists()){
        db.ref('rooms/' + currentRoomCode).remove();
      }
    });
  }
  resetLocalState();
  showView('home');
  limpiarCodigoDeUrl();
}

function salir(deleteRoom = true){
  if(roomRef){
    roomRef.off('value', onRoomUpdate);
    if(deleteRoom && currentRoomCode){
      db.ref('rooms/' + currentRoomCode).remove().catch(() => {});
    }
  }
  resetLocalState();
  showView('home');
  limpiarCodigoDeUrl();
}

function limpiarCodigoDeUrl(){
  if(location.search){
    history.replaceState(null, '', location.pathname);
  }
}

function resetLocalState(){
  if(presenceRef){
    presenceRef.onDisconnect().cancel();
    presenceRef.remove().catch(() => {});
  }
  if(presenceGraceTimer){
    clearTimeout(presenceGraceTimer);
    presenceGraceTimer = null;
  }
  roomRef = null;
  presenceRef = null;
  currentRoomCode = null;
  mySymbol = null;
  clearMarks();
  hideWinLine();
  gameResult.classList.add('hidden');
  detenerHeartbeat();
}

// ===================================================
// Heartbeat (solo lo manda el creador, mientras espera rival)
// ===================================================
function iniciarHeartbeatSiCorresponde(room){
  const soyCreadorEsperando = room && room.players.creator === clientId && room.status === 'waiting';
  if(!soyCreadorEsperando){
    detenerHeartbeat();
    return;
  }
  if(heartbeatTimer) return;
  const ref = db.ref('rooms/' + currentRoomCode + '/heartbeat');
  heartbeatTimer = setInterval(() => {
    ref.set(firebase.database.ServerValue.TIMESTAMP);
  }, HEARTBEAT_INTERVAL_MS);
}

// Cuando volvés de segundo plano (ej: volviste de WhatsApp después de
// compartir el link), el setInterval de arriba puede haber estado pausado
// todo ese rato. En vez de esperar a que dispare de nuevo, mandamos un
// heartbeat al toque para resetear el reloj de "sala abandonada".
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && heartbeatTimer && currentRoomCode){
    db.ref('rooms/' + currentRoomCode + '/heartbeat').set(firebase.database.ServerValue.TIMESTAMP);
  }
});

function detenerHeartbeat(){
  if(heartbeatTimer){
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ===================================================
// Detectar al rival desconectado (una vez que ya está en la sala)
// ===================================================
function getOpponentId(room){
  if(!room.players) return null;
  if(room.players.creator === clientId) return room.players.joiner || null;
  if(room.players.joiner === clientId) return room.players.creator || null;
  return null;
}

function vigilarPresenciaRival(room){
  const opponentId = getOpponentId(room);

  // todavía no hay rival (sala en espera): nada que vigilar
  if(!opponentId){
    if(presenceGraceTimer){ clearTimeout(presenceGraceTimer); presenceGraceTimer = null; }
    return;
  }

  const presence = room.presence || {};
  const opponentPresent = !!presence[opponentId];

  if(opponentPresent){
    if(presenceGraceTimer){ clearTimeout(presenceGraceTimer); presenceGraceTimer = null; }
    return;
  }

  // el rival no figura como presente: le damos un margen corto (puede ser
  // solo un refresh de página) antes de cerrar la sala para los dos
  if(!presenceGraceTimer){
    presenceGraceTimer = setTimeout(() => {
      presenceGraceTimer = null;
      db.ref('rooms/' + currentRoomCode).remove().catch(() => {});
    }, PRESENCE_GRACE_MS);
  }
}

// ===================================================
// Render en tiempo real
// ===================================================
function onRoomUpdate(snapshot){
  const room = snapshot.val();
  if(!room){
    salir(false);
    return;
  }

  iniciarHeartbeatSiCorresponde(room);
  //vigilarPresenciaRival(room);

  mySymbol = room.symbols ? room.symbols[clientId] : null;

  if(room.status === 'waiting'){
    renderCodigoSala(currentRoomCode);
    showView('waiting');
    return;
  }

  showView('game');
  renderJuego(room);
}

function renderCodigoSala(code){
  const letters = code.split('');
  roomCodeDisplay.querySelectorAll('.code-cell').forEach((el, i) => {
    el.textContent = letters[i];
  });
}

function renderJuego(room){
  roomCodeTag.textContent = currentRoomCode;

  const winInfo = checkWinner(room.board);
  const winLine = (winInfo && winInfo.line) ? winInfo.line : [];

  syncMarks(room.board, winLine);

  if(winInfo && winInfo.line){
    showWinLine(winInfo.line, winInfo.winner);
  }else{
    hideWinLine();
  }

  const cellButtons = boardLayer.querySelectorAll('.cell');

  if(room.status === 'finished'){
    cellButtons.forEach(btn => btn.disabled = true);
    gameResult.classList.remove('hidden');
    if(room.winner === 'draw'){
      resultText.textContent = 'Empate.';
    }else if(room.winner === mySymbol){
      resultText.textContent = '¡Ganaste! 🎉';
    }else{
      resultText.textContent = 'Perdiste. La próxima.';
    }
    turnIndicator.textContent = 'Terminó';
  }else{
    gameResult.classList.add('hidden');
    const isMyTurn = room.turn === mySymbol;
    cellButtons.forEach((btn, i) => {
      btn.disabled = !isMyTurn || !!room.board[i];
    });
    turnIndicator.textContent = isMyTurn ? 'Tu turno' : 'Turno rival';
  }
}

function syncMarks(board, winLine){
  board.forEach((val, i) => {
    if(val && !renderedMarks.has(i)){
      const box = getCellBox(i);
      const span = document.createElement('span');
      span.className = 'mark ' + (val === 'X' ? 'x' : 'o');
      span.textContent = val;
      span.style.left = box.centerX + '%';
      span.style.top = box.centerY + '%';
      span.dataset.i = i;
      boardLayer.appendChild(span);
      renderedMarks.add(i);
    }
  });

  boardLayer.querySelectorAll('.mark').forEach(span => {
    const i = Number(span.dataset.i);
    span.classList.toggle('win', winLine.includes(i));
  });

  if(board.every(v => !v)){
    clearMarks();
  }
}

function clearMarks(){
  boardLayer.querySelectorAll('.mark').forEach(el => el.remove());
  renderedMarks.clear();
}

const VB_W = 808, VB_H = 1600;

function showWinLine(line, winnerSymbol){
  if(winnerSymbol === 'draw') { hideWinLine(); return; }

  const startBox = getCellBox(line[0]);
  const endBox = getCellBox(line[2]);

  let x1 = (startBox.centerX / 100) * VB_W;
  let y1 = (startBox.centerY / 100) * VB_H;
  let x2 = (endBox.centerX / 100) * VB_W;
  let y2 = (endBox.centerY / 100) * VB_H;

  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ext = len * 0.18;
  const ux = dx / len, uy = dy / len;
  x1 -= ux * ext; y1 -= uy * ext;
  x2 += ux * ext; y2 += uy * ext;

  winLineEl.setAttribute('x1', x1);
  winLineEl.setAttribute('y1', y1);
  winLineEl.setAttribute('x2', x2);
  winLineEl.setAttribute('y2', y2);
  winLineEl.classList.remove('x', 'o', 'show');
  winLineEl.classList.add(winnerSymbol === 'X' ? 'x' : 'o');

  const fullLen = Math.hypot(x2 - x1, y2 - y1);
  winLineEl.style.transition = 'none';
  winLineEl.style.strokeDasharray = fullLen;
  winLineEl.style.strokeDashoffset = fullLen;

  void winLineEl.getBoundingClientRect();

  requestAnimationFrame(() => {
    winLineEl.style.transition = '';
    winLineEl.classList.add('show');
    winLineEl.style.strokeDashoffset = 0;
  });
}

function hideWinLine(){
  winLineEl.classList.remove('show', 'x', 'o');
}

// ===================================================
// Jugadas
// ===================================================
function jugar(i){
  if(!roomRef || !mySymbol) return;

  roomRef.transaction((room) => {
    if(!room) return room;
    if(room.status !== 'playing') return room;
    if(room.turn !== mySymbol) return room;
    if(room.board[i]) return room;

    room.board[i] = mySymbol;

    const winInfo = checkWinner(room.board);
    if(winInfo && winInfo.winner){
      room.status = 'finished';
      room.winner = winInfo.winner;
    }else{
      room.turn = mySymbol === 'X' ? 'O' : 'X';
    }
    return room;
  });
}

function pedirRevancha(){
  reiniciarPartida();
}

// Reinicia el tablero de la sala actual (misma sala, se vuelve a tirar la
// moneda). Sirve tanto para "Revancha" (cuando ya terminó) como para el
// botón de reiniciar en medio de una partida.
function reiniciarPartida(){
  if(!roomRef) return;
  roomRef.transaction((room) => {
    if(!room) return room;

    const players = room.players;
    const creatorStarts = Math.random() < 0.5;
    room.symbols = {
      [players.creator]: creatorStarts ? 'X' : 'O',
      [players.joiner]: creatorStarts ? 'O' : 'X'
    };

    room.board = ["","","","","","","","",""];
    room.status = 'playing';
    room.winner = null;
    room.turn = 'X';
    room.round = (room.round || 0) + 1;
    return room;
  });
}

function checkWinner(board){
  for(const line of WIN_LINES){
    const [a,b,c] = line;
    if(board[a] && board[a] === board[b] && board[a] === board[c]){
      return { winner: board[a], line };
    }
  }
  if(board.every(v => v)) return { winner: 'draw', line: null };
  return null;
}