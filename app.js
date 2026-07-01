// ===================================================
// TRIKI ONLINE — lógica de salas y partida
// ===================================================

const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // sin 0/O/1/I/L, evita confusiones
const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

// Límites de la grilla medidos sobre assets/board-bg.jpg (en % del contenedor)
// x: líneas verticales | y: líneas horizontales
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
let renderedMarks = new Set(); // índices que ya tienen su <span class="mark"> puesto

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

  // Si entraron por un link compartido (?code=XXXX), los metemos directo
  // a la partida sin que tengan que tocar "Unirse".
  if(codeFromUrl && codeFromUrl.trim().length === 4){
    unirsePartida(codeFromUrl.trim().toUpperCase());
  }
}

function buildRoomLink(code){
  return location.origin + location.pathname + '?code=' + code;
}

async function compartirLink(){
  if(!currentRoomCode) return;
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
    if(err.name === 'AbortError') return; // el usuario cerró el share sheet, no hacemos nada más
    // navigator.share no disponible (ej: PC): copiamos el link como respaldo.
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

// crea los 9 botones invisibles posicionados sobre las líneas de la foto
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
    // crypto.randomUUID() solo existe en contextos seguros (https o localhost).
    // Si no está disponible (ej: probando por http://IP-local:puerto), generamos
    // un id igual de único pero sin caracteres inválidos para claves de Firebase
    // (nada de ".", "#", "$", "/", "[", "]" — Math.random() de más produce ".").
    if(crypto.randomUUID){
      id = crypto.randomUUID();
    }else{
      const rand = Math.random().toString(36).slice(2); // sin punto, base36
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
      createdAt: firebase.database.ServerValue.TIMESTAMP
    };
    const ref = db.ref('rooms/' + code);
    await ref.set(room);
    // Si se corta la conexión del creador (cierra la pestaña, pierde señal, etc.)
    // Firebase borra la sala solo, del lado del servidor, sin depender de que
    // nuestro JS siga corriendo. Así el link de invitación deja de servir.
    ref.onDisconnect().remove();
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
      homeError.textContent = 'Ese link de invitación ya no es válido (Crea una partida nueva).';
      limpiarCodigoDeUrl();
      inputCode.value = '';
      return;
    }
    const room = snap.val();

    // Reconexión: ya sos parte de esta sala
    if(room.players.creator === clientId || room.players.joiner === clientId){
      entrarASala(code);
      return;
    }

    if(room.players.joiner){
      homeError.textContent = 'Esa sala ya está completa.';
      limpiarCodigoDeUrl();
      inputCode.value = '';
      return;
    }

    // Se completa la sala: acá se tira la moneda para ver quién arranca con X
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
  roomRef.on('value', onRoomUpdate);
  // dejamos el código en la URL para poder reconectar si se refresca la página
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
      // Cerrar la sala para ambos: al rival, su propio listener de onRoomUpdate
      // va a recibir room=null y lo va a mandar al home automáticamente.
      db.ref('rooms/' + currentRoomCode).remove().catch(() => {});
    }
  }
  resetLocalState();
  showView('home');
  limpiarCodigoDeUrl();
}

// Saca el ?code=XXXX de la barra de direcciones (sin recargar la página)
// para que un link de invitación viejo/usado no quede "pegado" en la URL.
function limpiarCodigoDeUrl(){
  if(location.search){
    history.replaceState(null, '', location.pathname);
  }
}

function resetLocalState(){
  roomRef = null;
  currentRoomCode = null;
  mySymbol = null;
  clearMarks();
  hideWinLine();
  gameResult.classList.add('hidden');
}

// ===================================================
// Render en tiempo real
// ===================================================
function onRoomUpdate(snapshot){
  const room = snapshot.val();
  if(!room){
    // La sala ya no existe: se cerró (el creador se desconectó, alguien se fue,
    // o el link de invitación apuntaba a una sala vieja/inexistente).
    // No hay nada que borrar de nuevo, solo mandamos a esta persona al home.
    salir(false);
    return;
  }

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

// crea/actualiza los <span class="mark"> encima de cada celda ocupada
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

// Dibuja la raya que tacha la línea ganadora (fila, columna o diagonal).
// Coordenadas convertidas de % del tablero a unidades del viewBox del SVG,
// así el ángulo y largo salen correctos sin importar el tamaño en pantalla.
const VB_W = 808, VB_H = 1600; // debe coincidir con el viewBox de #win-line-svg

function showWinLine(line, winnerSymbol){
  if(winnerSymbol === 'draw') { hideWinLine(); return; }

  const startBox = getCellBox(line[0]);
  const endBox = getCellBox(line[2]);

  let x1 = (startBox.centerX / 100) * VB_W;
  let y1 = (startBox.centerY / 100) * VB_H;
  let x2 = (endBox.centerX / 100) * VB_W;
  let y2 = (endBox.centerY / 100) * VB_H;

  // estiramos un poco cada punta para que cruce de lado a lado, no que
  // solo una los centros de las celdas de las puntas
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

  // forzamos reflow para que el próximo cambio sí anime
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
// Jugadas (con transacción para evitar condiciones de carrera)
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
  if(!roomRef) return;
  roomRef.transaction((room) => {
    if(!room) return room;

    // se vuelve a tirar la moneda para ver quién arranca
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