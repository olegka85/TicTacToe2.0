'use strict';

const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const SERVER_URL = SEARCH_PARAMS.get('server') ||
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000'
        : 'https://tictactoe-socket-production-7951.up.railway.app');
const SESSION_STORAGE_KEY = 'tictactoe.onlineSession.v1';

let socket = null;
let socketConnectPromise = null;
let roomId = null;
let myPlayerId = null;
let sessionToken = null;
let isMultiplayer = false;
let multiplayerStatus = 'idle';
let gameState = GameRules.createInitialState();
let celebratedWinner = null;
let confettiFrame = null;
let confettiResizeHandler = null;

const $ = (id) => document.getElementById(id);

function setVisible(id, visible) {
    $(id).hidden = !visible;
}

function hideSetupPanels() {
    setVisible('mainMenu', false);
    setVisible('multiplayerMenu', false);
    setVisible('createGameContainer', false);
}

function resetSessionState() {
    roomId = null;
    myPlayerId = null;
    sessionToken = null;
    multiplayerStatus = 'idle';
    gameState = GameRules.createInitialState();
    celebratedWinner = null;
    $('message').textContent = '';
    stopConfetti();
}

function normalizeRoomCode(value) {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return /^[A-Z2-9]{6}$/.test(normalized) ? normalized : null;
}

function getTelegramWebApp() {
    return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
}

function getInviteRoomId() {
    const queryRoom = normalizeRoomCode(SEARCH_PARAMS.get('room'));
    if (queryRoom) return queryRoom;

    const telegram = getTelegramWebApp();
    const startParam = telegram && telegram.initDataUnsafe
        ? telegram.initDataUnsafe.start_param
        : null;
    if (!startParam) return null;

    const normalizedStartParam = String(startParam).replace(/^room[_-]?/i, '');
    return normalizeRoomCode(normalizedStartParam);
}

function isSavedSession(value) {
    return Boolean(
        value &&
        normalizeRoomCode(value.roomId) &&
        typeof value.sessionToken === 'string' &&
        value.sessionToken.length >= 20 &&
        (value.playerId === 'X' || value.playerId === 'O')
    );
}

function readLocalSession() {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return isSavedSession(parsed) ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function writeSavedSession(value) {
    if (!isSavedSession(value)) return;

    const serialized = JSON.stringify(value);
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SESSION_STORAGE_KEY, serialized);
        }
    } catch (_error) {
        // Browser storage can be unavailable in privacy modes; Telegram CloudStorage is a fallback.
    }

    const telegram = getTelegramWebApp();
    const cloudStorage = telegram && telegram.CloudStorage;
    if (cloudStorage && typeof cloudStorage.setItem === 'function') {
        cloudStorage.setItem(SESSION_STORAGE_KEY, serialized, () => {});
    }
}

function clearSavedSession() {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        }
    } catch (_error) {
        // Ignore unavailable browser storage.
    }

    const telegram = getTelegramWebApp();
    const cloudStorage = telegram && telegram.CloudStorage;
    if (cloudStorage && typeof cloudStorage.removeItem === 'function') {
        cloudStorage.removeItem(SESSION_STORAGE_KEY, () => {});
    }
}

function readTelegramSession() {
    const telegram = getTelegramWebApp();
    const cloudStorage = telegram && telegram.CloudStorage;
    if (!cloudStorage || typeof cloudStorage.getItem !== 'function') {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        cloudStorage.getItem(SESSION_STORAGE_KEY, (error, raw) => {
            if (error || !raw) {
                resolve(null);
                return;
            }

            try {
                const parsed = JSON.parse(raw);
                resolve(isSavedSession(parsed) ? parsed : null);
            } catch (_error) {
                resolve(null);
            }
        });
    });
}

async function readSavedSession() {
    return readLocalSession() || await readTelegramSession();
}

function persistCurrentSession() {
    if (!roomId || !sessionToken || !myPlayerId) return;
    writeSavedSession({ roomId, sessionToken, playerId: myPlayerId });
}

function buildInviteUrl() {
    if (!roomId) return '';

    try {
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomId);
        url.hash = '';
        return url.toString();
    } catch (_error) {
        return '?room=' + encodeURIComponent(roomId);
    }
}

async function copyGameLink() {
    const inviteUrl = buildInviteUrl();
    if (!inviteUrl) return;

    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(inviteUrl);
            updateConnectionStatus('Ссылка на игру скопирована', '#b8ffbf');
            return;
        }
    } catch (_error) {
        // Fall through to showing the URL.
    }

    updateConnectionStatus('Ссылка: ' + inviteUrl, '#ffffff');
}

async function shareGame() {
    const inviteUrl = buildInviteUrl();
    if (!inviteUrl) return;

    const title = 'Крестики-Нолики 2.0';
    const text = 'Сыграем? Открой ссылку — первый ход будет твоим.';
    const telegram = getTelegramWebApp();

    if (telegram && telegram.initData && typeof telegram.openTelegramLink === 'function') {
        const shareUrl = 'https://t.me/share/url?url=' +
            encodeURIComponent(inviteUrl) + '&text=' + encodeURIComponent(text);
        telegram.openTelegramLink(shareUrl);
        return;
    }

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
            await navigator.share({ title, text, url: inviteUrl });
            return;
        } catch (error) {
            if (error && error.name === 'AbortError') return;
        }
    }

    await copyGameLink();
}

function startLocalGame() {
    leaveOnlineRoom();
    clearSavedSession();
    isMultiplayer = false;
    resetSessionState();
    hideSetupPanels();
    setVisible('gameContainer', true);
    ensureBoardRendered();
    updateConnectionStatus('Игра на одном устройстве', '#ffffff');
    updateUI();
}

function showMultiplayerMenu() {
    setVisible('mainMenu', false);
    setVisible('gameContainer', false);
    setVisible('createGameContainer', false);
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('', '#ffffff');
}

function backToMainMenu() {
    leaveOnlineRoom();
    clearSavedSession();
    isMultiplayer = false;
    resetSessionState();
    setVisible('multiplayerMenu', false);
    setVisible('createGameContainer', false);
    setVisible('gameContainer', false);
    setVisible('mainMenu', true);
    updateConnectionStatus('', '#ffffff');
}

function initSocket() {
    if (socket) return socket;

    socket = io(SERVER_URL, {
        autoConnect: false,
        transports: ['websocket', 'polling'],
        reconnection: true
    });

    socket.on('connect', () => {
        socketConnectPromise = null;

        if (isMultiplayer && roomId && sessionToken && multiplayerStatus === 'disconnected') {
            multiplayerStatus = 'restoring';
            updateConnectionStatus('Восстанавливаем партию…', '#ffffff');
            socket.emit('resumeGame', { roomId, sessionToken });
            return;
        }

        if (!roomId) updateConnectionStatus('🟢 Подключено к серверу', '#b8ffbf');
    });

    socket.on('disconnect', () => {
        socketConnectPromise = null;
        if (isMultiplayer) {
            multiplayerStatus = 'disconnected';
            updateConnectionStatus('🔴 Соединение с сервером потеряно', '#ffb0b0');
            updateUI();
        }
    });

    socket.on('connect_error', (error) => {
        socketConnectPromise = null;
        updateConnectionStatus(`🔴 Не удалось подключиться: ${error.message}`, '#ffb0b0');
    });

    socket.on('gameState', handleGameState);

    socket.on('gameError', (payload) => {
        const message = payload && payload.message ? payload.message : 'Ошибка игры';
        const code = payload && payload.code ? payload.code : 'GAME_ERROR';
        const enteringGame = multiplayerStatus === 'joining' || multiplayerStatus === 'restoring';

        if (enteringGame && ['ROOM_NOT_FOUND', 'INVALID_SESSION', 'ROOM_FULL', 'INVALID_ROOM'].includes(code)) {
            clearSavedSession();
            isMultiplayer = false;
            resetSessionState();
            setVisible('gameContainer', false);
            setVisible('createGameContainer', false);
            setVisible('mainMenu', false);
            setVisible('multiplayerMenu', true);
        }

        updateConnectionStatus('⚠️ ' + message, '#ffe49a');
    });

    socket.on('sessionReplaced', (payload) => {
        multiplayerStatus = 'replaced';
        const message = payload && payload.message ? payload.message : 'Партия открыта в другом окне.';
        updateConnectionStatus('⚠️ ' + message, '#ffe49a');
        updateUI();
    });

    socket.on('opponentLeft', (payload) => {
        const message = payload && payload.message ? payload.message : 'Соперник вышел.';
        updateConnectionStatus(`⚠️ ${message}`, '#ffe49a');
    });

    socket.on('roomClosed', (payload) => {
        const message = payload && payload.message ? payload.message : 'Комната закрыта.';
        clearSavedSession();
        isMultiplayer = false;
        resetSessionState();
        setVisible('gameContainer', false);
        setVisible('createGameContainer', false);
        setVisible('mainMenu', false);
        setVisible('multiplayerMenu', true);
        updateConnectionStatus(`⚠️ ${message}`, '#ffe49a');
    });

    return socket;
}

function ensureSocketConnected() {
    const activeSocket = initSocket();
    if (activeSocket.connected) return Promise.resolve(activeSocket);
    if (socketConnectPromise) return socketConnectPromise;

    socketConnectPromise = new Promise((resolve, reject) => {
        const onConnect = () => {
            cleanup();
            resolve(activeSocket);
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            activeSocket.off('connect', onConnect);
            activeSocket.off('connect_error', onError);
        };

        activeSocket.once('connect', onConnect);
        activeSocket.once('connect_error', onError);
        activeSocket.connect();
    });

    return socketConnectPromise;
}

async function showCreateGame() {
    hideSetupPanels();
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('Подключаемся к серверу…', '#ffffff');

    try {
        const activeSocket = await ensureSocketConnected();
        clearSavedSession();
        isMultiplayer = true;
        multiplayerStatus = 'creating';
        activeSocket.emit('createGame');
        updateConnectionStatus('Создаём игру…', '#ffffff');
    } catch (error) {
        setVisible('multiplayerMenu', true);
        updateConnectionStatus('🔴 Сервер недоступен: ' + error.message, '#ffb0b0');
    }
}

async function joinGameByLink(code) {
    const normalizedRoomId = normalizeRoomCode(code);
    if (!normalizedRoomId) return;

    hideSetupPanels();
    setVisible('gameContainer', false);
    isMultiplayer = true;
    roomId = normalizedRoomId;
    myPlayerId = null;
    sessionToken = null;
    multiplayerStatus = 'joining';
    updateConnectionStatus('Открываем приглашение…', '#ffffff');

    try {
        const activeSocket = await ensureSocketConnected();
        activeSocket.emit('joinGame', { roomId: normalizedRoomId });
    } catch (error) {
        isMultiplayer = false;
        resetSessionState();
        setVisible('multiplayerMenu', true);
        updateConnectionStatus('🔴 Сервер недоступен: ' + error.message, '#ffb0b0');
    }
}

async function resumeSavedGame(savedSession) {
    if (!isSavedSession(savedSession)) return;

    hideSetupPanels();
    isMultiplayer = true;
    roomId = savedSession.roomId;
    myPlayerId = savedSession.playerId;
    sessionToken = savedSession.sessionToken;
    multiplayerStatus = 'restoring';
    setVisible('gameContainer', true);
    ensureBoardRendered();
    updateUI();
    updateConnectionStatus('Восстанавливаем сохранённую партию…', '#ffffff');

    try {
        const activeSocket = await ensureSocketConnected();
        activeSocket.emit('resumeGame', { roomId, sessionToken });
    } catch (error) {
        multiplayerStatus = 'disconnected';
        updateConnectionStatus('🔴 Сервер недоступен: ' + error.message, '#ffb0b0');
        updateUI();
    }
}

async function restoreOrJoinOnlineGame() {
    const inviteRoomId = getInviteRoomId();
    const savedSession = await readSavedSession();

    if (inviteRoomId && savedSession && savedSession.roomId === inviteRoomId) {
        await resumeSavedGame(savedSession);
        return;
    }

    if (inviteRoomId) {
        clearSavedSession();
        await joinGameByLink(inviteRoomId);
        return;
    }

    if (savedSession) {
        await resumeSavedGame(savedSession);
    }
}

function handleGameState(payload) {
    if (!payload || !payload.state || !payload.roomId || !payload.playerId) return;

    roomId = payload.roomId;
    myPlayerId = payload.playerId;
    sessionToken = payload.sessionToken || sessionToken;
    multiplayerStatus = payload.status;
    gameState = payload.state;
    isMultiplayer = true;
    persistCurrentSession();

    hideSetupPanels();
    setVisible('gameContainer', true);
    ensureBoardRendered();

    if (multiplayerStatus === 'waiting') {
        setVisible('createGameContainer', myPlayerId === 'O');
    }

    updateUI();
    updateMultiplayerStatus();
}

function updateMultiplayerStatus() {
    if (!isMultiplayer) return;

    if (multiplayerStatus === 'waiting') {
        updateConnectionStatus('🟡 Игра создана. Отправьте приглашение второму игроку.', '#ffe49a');
    } else if (multiplayerStatus === 'paused') {
        updateConnectionStatus('🟡 Соперник не в сети. Партия сохранена.', '#ffe49a');
    } else if (multiplayerStatus === 'finished') {
        updateConnectionStatus('Игра завершена', '#ffffff');
    } else if (multiplayerStatus === 'playing') {
        updateConnectionStatus(
            gameState.currentPlayer === myPlayerId ? '🟢 Ваш ход' : '🟡 Ход соперника',
            gameState.currentPlayer === myPlayerId ? '#b8ffbf' : '#ffe49a'
        );
    }
}

function updateConnectionStatus(text, color) {
    $('connectionStatus').textContent = text;
    $('connectionStatus').style.color = color;
}

function cancelGame() {
    leaveOnlineRoom();
    clearSavedSession();
    isMultiplayer = false;
    resetSessionState();
    setVisible('createGameContainer', false);
    setVisible('gameContainer', false);
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('', '#ffffff');
}


function exitGame() {
    if (isMultiplayer) {
        leaveOnlineRoom();
        clearSavedSession();
        isMultiplayer = false;
        resetSessionState();
        setVisible('gameContainer', false);
        setVisible('createGameContainer', false);
        setVisible('multiplayerMenu', true);
        updateConnectionStatus('', '#ffffff');
        return;
    }
    backToMainMenu();
}

function leaveOnlineRoom() {
    if (socket && socket.connected && roomId) {
        socket.emit('leaveGame');
    }
}


function ensureBoardRendered() {
    const bigBoard = $('bigBoard');
    if (bigBoard.children.length === 9) return;

    bigBoard.innerHTML = '';
    for (let boardIndex = 0; boardIndex < 9; boardIndex += 1) {
        const smallBoard = document.createElement('div');
        smallBoard.className = 'small-board';
        smallBoard.id = `board-${boardIndex}`;

        for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.id = `cell-${boardIndex}-${cellIndex}`;
            cell.setAttribute('role', 'button');
            cell.setAttribute('aria-label', `Поле ${boardIndex + 1}, клетка ${cellIndex + 1}`);
            cell.addEventListener('click', () => makeMove(boardIndex, cellIndex));
            smallBoard.appendChild(cell);
        }

        bigBoard.appendChild(smallBoard);
    }
}

function makeMove(boardIndex, cellIndex) {
    if (isMultiplayer) {
        if (!socket || !socket.connected || !roomId || !myPlayerId) return;
        if (multiplayerStatus !== 'playing') return;
        if (gameState.currentPlayer !== myPlayerId) return;

        const error = GameRules.validateMove(gameState, boardIndex, cellIndex, myPlayerId);
        if (error) {
            updateConnectionStatus(`⚠️ ${error}`, '#ffe49a');
            return;
        }

        socket.emit('makeMove', { roomId, boardIndex, cellIndex });
        return;
    }

    const result = GameRules.applyMove(gameState, boardIndex, cellIndex, gameState.currentPlayer);
    if (!result.ok) return;
    gameState = result.state;
    updateUI();
}

function updateUI() {
    ensureBoardRendered();
    const canInteractOnline = !isMultiplayer || (
        multiplayerStatus === 'playing' &&
        socket && socket.connected &&
        gameState.currentPlayer === myPlayerId
    );

    for (let boardIndex = 0; boardIndex < 9; boardIndex += 1) {
        const smallBoard = $(`board-${boardIndex}`);
        smallBoard.className = 'small-board';

        const boardResult = gameState.bigBoard[boardIndex];
        if (boardResult === 'X') smallBoard.classList.add('won-x');
        if (boardResult === 'O') smallBoard.classList.add('won-o');
        if (boardResult === 'draw') smallBoard.classList.add('draw');

        const hasWinner = !gameState.gameActive && (gameState.winner === 'X' || gameState.winner === 'O');
        const winningBoard = hasWinner && boardResult === gameState.winner;
        if (hasWinner) smallBoard.classList.add(winningBoard ? 'winning-board' : 'muted-board');
        const winningCells = winningBoard
            ? GameRules.WIN_PATTERNS.filter((line) => line.every((index) =>
                gameState.smallBoards[boardIndex][index] === gameState.winner)).flat()
            : [];

        const boardAllowed = gameState.nextBoard === null || gameState.nextBoard === boardIndex;
        const boardPlayable = gameState.gameActive && boardResult === null && boardAllowed;
        if (boardPlayable && canInteractOnline) smallBoard.classList.add('active-board');

        for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
            const cell = $(`cell-${boardIndex}-${cellIndex}`);
            const value = gameState.smallBoards[boardIndex][cellIndex];
            cell.textContent = value || '';
            cell.className = 'cell';
            if (winningCells.includes(cellIndex)) cell.classList.add('winning-cell');

            if (value) {
                cell.classList.add('taken', value.toLowerCase());
            } else if (!boardPlayable || !canInteractOnline) {
                cell.classList.add('disabled');
            }
        }
    }

    $('currentPlayer').textContent = gameState.gameActive ? gameState.currentPlayer : '—';
    $('nextBoard').textContent = !gameState.gameActive
        ? '—'
        : gameState.nextBoard === null ? 'Любое' : String(gameState.nextBoard + 1);

    $('restartBtn').disabled = isMultiplayer && multiplayerStatus !== 'playing' && multiplayerStatus !== 'finished';
    updateGameMessage();
}

function updateGameMessage() {
    if (gameState.gameActive) {
        // Also runs on the other client's restart and on a new online room.
        if (celebratedWinner !== null) {
            celebratedWinner = null;
            stopConfetti();
        }
        $('message').textContent = isMultiplayer && multiplayerStatus === 'waiting'
            ? 'Ожидаем второго игрока…'
            : '';
        return;
    }

    if (gameState.winner === 'draw') {
        $('message').textContent = '🤝 Ничья!';
        return;
    }

    if (isMultiplayer) {
        $('message').textContent = gameState.winner === myPlayerId
            ? '🎉 Вы победили!'
            : `Победил игрок ${gameState.winner}`;
    } else {
        $('message').textContent = `🎉 Победил ${gameState.winner}!`;
    }

    if (celebratedWinner !== gameState.winner) {
        celebratedWinner = gameState.winner;
        startVictoryConfetti(gameState.winner);
    }
}

function restartGame() {
    if (isMultiplayer) {
        if (socket && socket.connected && roomId && multiplayerStatus !== 'waiting') {
            socket.emit('restartGame', { roomId });
        }
        return;
    }

    gameState = GameRules.createInitialState();
    updateUI();
}

function startVictoryConfetti(winner) {
    stopConfetti();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = $('confettiCanvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const particles = [];
    const palette = [
        '#ff3b30', '#ff6b6b', '#ffd60a', '#ffe66d', '#32d74b', '#8bea6d',
        winner === 'X' ? '#ff9f0a' : '#64d2ff', '#ffffff'
    ];

    const SPAWN_DURATION = 5200;
    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    let lastBottomVolleyAt = -Infinity;
    let lastTopRainAt = -Infinity;

    const resizeCanvas = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(window.innerWidth * dpr);
        canvas.height = Math.floor(window.innerHeight * dpr);
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    confettiResizeHandler = resizeCanvas;
    window.addEventListener('resize', confettiResizeHandler);
    resizeCanvas();
    canvas.style.display = 'block';

    const random = (min, max) => Math.random() * (max - min) + min;
    const color = () => palette[Math.floor(Math.random() * palette.length)];

    function addParticle(options) {
        if (particles.length >= 760) return;

        particles.push({
            x: options.x,
            y: options.y,
            vx: options.vx,
            vy: options.vy,
            gravity: options.gravity,
            drag: options.drag,
            size: options.size,
            maxAge: options.maxAge,
            age: 0,
            rotation: random(0, Math.PI * 2),
            rotationSpeed: random(-10, 10),
            color: color(),
            shape: Math.random() > 0.25 ? 'rect' : 'circle'
        });
    }

    function launchWinningBoardBurst() {
        const boardIndex = gameState.bigBoard.indexOf(winner);
        const board = $(`board-${boardIndex}`);
        if (!board) return;
        const rect = board.getBoundingClientRect();
        for (let i = 0; i < 90; i += 1) {
            const angle = random(0, Math.PI * 2);
            const speed = random(150, 360);
            addParticle({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 180,
                gravity: 200,
                drag: 0.65,
                size: random(7, 13),
                maxAge: random(6000, 8000)
            });
        }
    }

    function launchBottomVolley() {
        const lanes = [0.12, 0.3, 0.5, 0.7, 0.88];
        const originX = window.innerWidth * lanes[Math.floor(Math.random() * lanes.length)] + random(-20, 20);
        const amount = Math.floor(random(36, 52));

        for (let i = 0; i < amount; i += 1) {
            const angle = -Math.PI / 2 + random(-0.5, 0.5);
            const gravity = random(110, 150);
            // A slower, softer arc that still reaches the board on tall phones.
            const speed = Math.sqrt(2 * gravity * window.innerHeight * random(0.45, 0.65));

            addParticle({
                x: originX + random(-14, 14),
                y: window.innerHeight + random(5, 20),
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                gravity,
                drag: random(0.52, 0.74),
                size: random(7, 13),
                maxAge: random(6500, 8500)
            });
        }
    }

    function sprinkleFromTop() {
        const amount = Math.floor(random(3, 7));

        for (let i = 0; i < amount; i += 1) {
            addParticle({
                x: random(0, window.innerWidth),
                y: random(-50, -10),
                vx: random(-48, 48),
                vy: random(84, 192),
                gravity: random(100, 160),
                drag: 0.84,
                size: random(5, 9),
                maxAge: random(7000, 9000)
            });
        }
    }

    function drawParticle(particle, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        ctx.fillStyle = particle.color;

        if (particle.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.7);
        }

        ctx.restore();
    }

    function animate(now) {
        const elapsed = now - startedAt;
        const spawning = elapsed < SPAWN_DURATION;
        const deltaMs = Math.max(0, now - lastFrameAt);
        const dt = deltaMs / 1000;
        lastFrameAt = now;

        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

        for (let i = particles.length - 1; i >= 0; i -= 1) {
            const particle = particles[i];
            particle.age += deltaMs;
            const drag = Math.pow(particle.drag, dt);
            particle.x += particle.vx * (1 - drag) / -Math.log(particle.drag);
            particle.y += particle.vy * dt + 0.5 * particle.gravity * dt * dt;
            particle.vx *= drag;
            particle.vy += particle.gravity * dt;
            particle.rotation += particle.rotationSpeed * dt;

            if (
                particle.age >= particle.maxAge ||
                particle.y > window.innerHeight + 100 ||
                particle.x < -120 ||
                particle.x > window.innerWidth + 120
            ) {
                particles.splice(i, 1);
            }
        }

        if (spawning && now - lastBottomVolleyAt >= 320) {
            launchBottomVolley();
            lastBottomVolleyAt = now;
        }
        if (spawning && now - lastTopRainAt >= 260) {
            sprinkleFromTop();
            lastTopRainAt = now;
        }
        for (const particle of particles) {
            const fadeFrom = particle.maxAge * 0.8;
            const alpha = particle.age <= fadeFrom
                ? 1
                : Math.max(0, 1 - (particle.age - fadeFrom) / (particle.maxAge - fadeFrom));
            drawParticle(particle, alpha);
        }

        if (spawning || particles.length > 0) {
            confettiFrame = requestAnimationFrame(animate);
        } else {
            stopConfetti();
        }
    }

    launchWinningBoardBurst();
    confettiFrame = requestAnimationFrame(animate);
}

function stopConfetti() {
    if (confettiFrame !== null) cancelAnimationFrame(confettiFrame);
    confettiFrame = null;

    if (confettiResizeHandler) {
        window.removeEventListener('resize', confettiResizeHandler);
        confettiResizeHandler = null;
    }

    const canvas = $('confettiCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
}
const telegramWebApp = getTelegramWebApp();
if (telegramWebApp) {
    telegramWebApp.ready();
    telegramWebApp.expand();
}

restoreOrJoinOnlineGame();