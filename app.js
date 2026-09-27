'use strict';

const SERVER_URL = new URLSearchParams(window.location.search).get('server') ||
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000'
        : 'https://tictactoe-socket-production-7951.up.railway.app');

let socket = null;
let socketConnectPromise = null;
let roomId = null;
let myPlayerId = null;
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
    setVisible('joinGameContainer', false);
}

function resetSessionState() {
    roomId = null;
    myPlayerId = null;
    multiplayerStatus = 'idle';
    gameState = GameRules.createInitialState();
    celebratedWinner = null;
    $('message').textContent = '';
    $('gameCodeDisplay').textContent = '';
    $('roomCodeInput').value = '';
    stopConfetti();
}

function startLocalGame() {
    leaveOnlineRoom();
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
    setVisible('joinGameContainer', false);
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('', '#ffffff');
}

function backToMainMenu() {
    leaveOnlineRoom();
    isMultiplayer = false;
    resetSessionState();
    setVisible('multiplayerMenu', false);
    setVisible('createGameContainer', false);
    setVisible('joinGameContainer', false);
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
        updateConnectionStatus(`⚠️ ${message}`, '#ffe49a');
    });

    socket.on('opponentLeft', (payload) => {
        const message = payload && payload.message ? payload.message : 'Соперник вышел.';
        updateConnectionStatus(`⚠️ ${message}`, '#ffe49a');
    });

    socket.on('roomClosed', (payload) => {
        const message = payload && payload.message ? payload.message : 'Комната закрыта.';
        isMultiplayer = false;
        resetSessionState();
        setVisible('gameContainer', false);
        setVisible('createGameContainer', false);
        setVisible('joinGameContainer', false);
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
        isMultiplayer = true;
        activeSocket.emit('createGame');
        updateConnectionStatus('Создаём комнату…', '#ffffff');
    } catch (error) {
        setVisible('multiplayerMenu', true);
        updateConnectionStatus(`🔴 Сервер недоступен: ${error.message}`, '#ffb0b0');
    }
}

function showJoinGame() {
    setVisible('multiplayerMenu', false);
    setVisible('joinGameContainer', true);
    $('roomCodeInput').focus();
}

async function joinGame() {
    const code = $('roomCodeInput').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
        updateConnectionStatus('Введите шестизначный код комнаты', '#ffe49a');
        return;
    }

    updateConnectionStatus('Подключаемся к серверу…', '#ffffff');
    try {
        const activeSocket = await ensureSocketConnected();
        isMultiplayer = true;
        activeSocket.emit('joinGame', { roomId: code });
    } catch (error) {
        updateConnectionStatus(`🔴 Сервер недоступен: ${error.message}`, '#ffb0b0');
    }
}

function handleGameState(payload) {
    if (!payload || !payload.state || !payload.roomId || !payload.playerId) return;

    roomId = payload.roomId;
    myPlayerId = payload.playerId;
    multiplayerStatus = payload.status;
    gameState = payload.state;
    isMultiplayer = true;

    hideSetupPanels();
    setVisible('gameContainer', true);
    ensureBoardRendered();

    if (multiplayerStatus === 'waiting') {
        setVisible('createGameContainer', myPlayerId === 'X');
        if (myPlayerId === 'X') $('gameCodeDisplay').textContent = roomId;
    }

    updateUI();
    updateMultiplayerStatus();
}

function updateMultiplayerStatus() {
    if (!isMultiplayer) return;

    if (multiplayerStatus === 'waiting') {
        updateConnectionStatus(`🟡 Ожидание второго игрока. Код: ${roomId}`, '#ffe49a');
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
    isMultiplayer = false;
    resetSessionState();
    setVisible('createGameContainer', false);
    setVisible('gameContainer', false);
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('', '#ffffff');
}

function cancelJoin() {
    setVisible('joinGameContainer', false);
    setVisible('multiplayerMenu', true);
    updateConnectionStatus('', '#ffffff');
}

function exitGame() {
    if (isMultiplayer) {
        leaveOnlineRoom();
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

async function copyGameCode() {
    const code = $('gameCodeDisplay').textContent;
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        updateConnectionStatus('Код скопирован', '#b8ffbf');
    } catch (_error) {
        updateConnectionStatus(`Код комнаты: ${code}`, '#ffffff');
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

        const boardAllowed = gameState.nextBoard === null || gameState.nextBoard === boardIndex;
        const boardPlayable = gameState.gameActive && boardResult === null && boardAllowed;
        if (boardPlayable && canInteractOnline) smallBoard.classList.add('active-board');

        for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
            const cell = $(`cell-${boardIndex}-${cellIndex}`);
            const value = gameState.smallBoards[boardIndex][cellIndex];
            cell.textContent = value || '';
            cell.className = 'cell';

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

    $('restartBtn').disabled = isMultiplayer && multiplayerStatus === 'waiting';
    updateGameMessage();
}

function updateGameMessage() {
    if (gameState.gameActive) {
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
        if (gameState.winner === myPlayerId) {
            $('message').textContent = '🎉 Вы победили!';
            if (celebratedWinner !== gameState.winner) {
                celebratedWinner = gameState.winner;
                startVictoryConfetti(gameState.winner);
            }
        } else {
            $('message').textContent = `Победил игрок ${gameState.winner}`;
        }
    } else {
        $('message').textContent = `🎉 Победил ${gameState.winner}!`;
        if (celebratedWinner !== gameState.winner) {
            celebratedWinner = gameState.winner;
            startVictoryConfetti(gameState.winner);
        }
    }
}

function restartGame() {
    celebratedWinner = null;
    renderedBigBoard = null;
    stopConfetti();
    $('message').textContent = '';

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
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    stopConfetti();

    const canvas = $('confettiCanvas');
    const ctx = canvas.getContext('2d');
    const particles = [];
    const palette = winner === 'X'
        ? ['#ff3b30', '#ff6b35', '#ffd60a', '#fff1e8', '#ffffff']
        : ['#0a84ff', '#30d5c8', '#64d2ff', '#d9efff', '#ffffff'];

    const SPAWN_DURATION = 5200;
    const startedAt = performance.now();
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
            rotationSpeed: random(-0.22, 0.22),
            color: color(),
            shape: Math.random() > 0.25 ? 'rect' : 'circle'
        });
    }

    function launchBottomVolley() {
        const lanes = [0.12, 0.3, 0.5, 0.7, 0.88];
        const originX = window.innerWidth * lanes[Math.floor(Math.random() * lanes.length)] + random(-20, 20);
        const amount = Math.floor(random(36, 52));

        for (let i = 0; i < amount; i += 1) {
            const angle = -Math.PI / 2 + random(-0.5, 0.5);
            const speed = random(8.5, 14.5);

            addParticle({
                x: originX + random(-14, 14),
                y: window.innerHeight + random(5, 20),
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                gravity: random(0.16, 0.23),
                drag: random(0.989, 0.995),
                size: random(4.5, 10.5),
                maxAge: random(4200, 6800)
            });
        }
    }

    function sprinkleFromTop() {
        const amount = Math.floor(random(3, 7));

        for (let i = 0; i < amount; i += 1) {
            addParticle({
                x: random(0, window.innerWidth),
                y: random(-50, -10),
                vx: random(-0.8, 0.8),
                vy: random(1.4, 3.2),
                gravity: random(0.045, 0.085),
                drag: 0.997,
                size: random(3.5, 7.5),
                maxAge: random(4300, 7200)
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

        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

        if (spawning && now - lastBottomVolleyAt >= 190) {
            launchBottomVolley();
            lastBottomVolleyAt = now;
        }

        if (spawning && now - lastTopRainAt >= 260) {
            sprinkleFromTop();
            lastTopRainAt = now;
        }

        for (let i = particles.length - 1; i >= 0; i -= 1) {
            const particle = particles[i];
            particle.age += 16.7;
            particle.x += particle.vx;
            particle.y += particle.vy;
            particle.vx *= particle.drag;
            particle.vy += particle.gravity;
            particle.rotation += particle.rotationSpeed;

            const fadeFrom = particle.maxAge * 0.78;
            const alpha = particle.age <= fadeFrom
                ? 1
                : Math.max(0, 1 - (particle.age - fadeFrom) / (particle.maxAge - fadeFrom));

            drawParticle(particle, alpha);

            if (
                particle.age >= particle.maxAge ||
                particle.y > window.innerHeight + 100 ||
                particle.x < -120 ||
                particle.x > window.innerWidth + 120
            ) {
                particles.splice(i, 1);
            }
        }

        if (spawning || particles.length > 0) {
            confettiFrame = requestAnimationFrame(animate);
        } else {
            stopConfetti();
        }
    }

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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
}
$('roomCodeInput').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
});

$('roomCodeInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinGame();
});

if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
}
