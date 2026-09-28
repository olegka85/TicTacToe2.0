const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const GameRules = require('./game-rules');

const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'tictactoe-socket',
        features: ['share-link-v1', 'session-resume-v1', 'async-turns-v1']
    });
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const games = new Map();
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WAITING_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const INACTIVE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createRoomId() {
    let roomId;
    do {
        roomId = Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('');
    } while (games.has(roomId));
    return roomId;
}

function createSessionToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function normalizeRoomId(value) {
    const raw = typeof value === 'string' ? value : value && value.roomId;
    return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function normalizeSessionToken(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function createPlayer(socket) {
    return {
        sessionToken: createSessionToken(),
        socketId: socket.id
    };
}

function getPlayerId(game, socketId) {
    if (game.players.X && game.players.X.socketId === socketId) return 'X';
    if (game.players.O && game.players.O.socketId === socketId) return 'O';
    return null;
}

function getPlayerIdByToken(game, sessionToken) {
    if (game.players.X && game.players.X.sessionToken === sessionToken) return 'X';
    if (game.players.O && game.players.O.sessionToken === sessionToken) return 'O';
    return null;
}

function getStatus(game) {
    if (!game.players.X) return 'waiting';
    if (!game.state.gameActive) return 'finished';
    return 'playing';
}

function buildStatePayload(game, playerId) {
    const player = game.players[playerId];
    return {
        roomId: game.id,
        playerId,
        sessionToken: player ? player.sessionToken : null,
        status: getStatus(game),
        players: {
            X: Boolean(game.players.X),
            O: Boolean(game.players.O),
            connected: {
                X: Boolean(game.players.X && game.players.X.socketId),
                O: Boolean(game.players.O && game.players.O.socketId)
            }
        },
        state: GameRules.cloneState(game.state)
    };
}

function emitState(game) {
    for (const playerId of ['X', 'O']) {
        const player = game.players[playerId];
        if (!player || !player.socketId) continue;
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
            playerSocket.emit('gameState', buildStatePayload(game, playerId));
        }
    }
}

function emitGameError(socket, message, code = 'GAME_ERROR') {
    socket.emit('gameError', { message, code });
}

function clearSocketRoomData(socket) {
    socket.data.roomId = null;
    socket.data.playerId = null;
}

function bindPlayerToSocket(game, playerId, socket) {
    const player = game.players[playerId];
    if (!player) return false;

    if (player.socketId && player.socketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(player.socketId);
        if (previousSocket) {
            previousSocket.leave(game.id);
            clearSocketRoomData(previousSocket);
            previousSocket.emit('sessionReplaced', {
                message: 'Эта партия открыта в другом окне или на другом устройстве.'
            });
        }
    }

    player.socketId = socket.id;
    socket.join(game.id);
    socket.data.roomId = game.id;
    socket.data.playerId = playerId;
    game.updatedAt = Date.now();
    return true;
}

function closeGame(game, message) {
    games.delete(game.id);

    for (const playerId of ['X', 'O']) {
        const player = game.players[playerId];
        if (!player || !player.socketId) continue;
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (!playerSocket) continue;
        playerSocket.leave(game.id);
        clearSocketRoomData(playerSocket);
        playerSocket.emit('roomClosed', { message });
    }
}

function leaveCurrentGame(socket, options = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    const playerId = game ? getPlayerId(game, socket.id) : null;

    clearSocketRoomData(socket);
    socket.leave(roomId);

    if (!game || !playerId) return;

    const player = game.players[playerId];
    if (player && player.socketId === socket.id) {
        player.socketId = null;
    }
    game.updatedAt = Date.now();

    if (!options.explicit) {
        emitState(game);
        return;
    }

    if (playerId === 'O') {
        games.delete(roomId);
        const opponent = game.players.X;
        if (opponent && opponent.socketId) {
            const opponentSocket = io.sockets.sockets.get(opponent.socketId);
            if (opponentSocket) {
                opponentSocket.leave(roomId);
                clearSocketRoomData(opponentSocket);
                opponentSocket.emit('roomClosed', {
                    message: 'Создатель завершил эту комнату.'
                });
            }
        }
        return;
    }

    game.players.X = null;
    game.state = GameRules.createInitialState();
    game.updatedAt = Date.now();

    const creator = game.players.O;
    if (creator && creator.socketId) {
        const creatorSocket = io.sockets.sockets.get(creator.socketId);
        if (creatorSocket) {
            creatorSocket.emit('opponentLeft', {
                message: 'Соперник вышел. Можно отправить приглашение снова.'
            });
        }
    }
    emitState(game);
}

io.on('connection', (socket) => {
    console.log('Игрок подключился: ' + socket.id);

    socket.on('createGame', () => {
        leaveCurrentGame(socket, { explicit: true });

        const roomId = createRoomId();
        const game = {
            id: roomId,
            players: { X: null, O: createPlayer(socket) },
            state: GameRules.createInitialState(),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        games.set(roomId, game);
        bindPlayerToSocket(game, 'O', socket);
        emitState(game);
        console.log('Игра создана: ' + roomId);
    });

    socket.on('joinGame', (payload) => {
        const roomId = normalizeRoomId(payload);
        if (!/^[A-Z2-9]{6}$/.test(roomId)) {
            emitGameError(socket, 'Некорректная ссылка на игру', 'INVALID_ROOM');
            return;
        }

        const game = games.get(roomId);
        if (!game) {
            emitGameError(socket, 'Игра не найдена или уже завершена', 'ROOM_NOT_FOUND');
            return;
        }
        if (game.players.X) {
            emitGameError(socket, 'К этой игре уже присоединились', 'ROOM_FULL');
            return;
        }

        leaveCurrentGame(socket, { explicit: true });
        game.players.X = createPlayer(socket);
        game.state = GameRules.createInitialState();
        game.updatedAt = Date.now();

        bindPlayerToSocket(game, 'X', socket);
        emitState(game);
        console.log('Игрок X присоединился к игре: ' + roomId);
    });

    socket.on('resumeGame', (payload = {}) => {
        const roomId = normalizeRoomId(payload);
        const sessionToken = normalizeSessionToken(payload.sessionToken);

        if (!/^[A-Z2-9]{6}$/.test(roomId) || !sessionToken) {
            emitGameError(socket, 'Не удалось восстановить сохранённую партию', 'INVALID_SESSION');
            return;
        }

        const game = games.get(roomId);
        if (!game) {
            emitGameError(socket, 'Сохранённая партия больше не существует', 'ROOM_NOT_FOUND');
            return;
        }

        const playerId = getPlayerIdByToken(game, sessionToken);
        if (!playerId) {
            emitGameError(socket, 'Сессия этой партии недействительна', 'INVALID_SESSION');
            return;
        }

        if (socket.data.roomId && socket.data.roomId !== roomId) {
            leaveCurrentGame(socket, { explicit: true });
        }

        bindPlayerToSocket(game, playerId, socket);
        emitState(game);
        console.log('Игрок ' + playerId + ' вернулся в игру: ' + roomId);
    });

    socket.on('makeMove', (payload = {}) => {
        const roomId = normalizeRoomId(payload);
        const game = games.get(roomId);

        if (!game) {
            emitGameError(socket, 'Игра не найдена', 'ROOM_NOT_FOUND');
            return;
        }

        const playerId = getPlayerId(game, socket.id);
        if (!playerId || socket.data.roomId !== roomId) {
            emitGameError(socket, 'Вы не участвуете в этой игре', 'NOT_IN_GAME');
            return;
        }
        const boardIndex = Number(payload.boardIndex);
        const cellIndex = Number(payload.cellIndex);
        const result = GameRules.applyMove(game.state, boardIndex, cellIndex, playerId);

        if (!result.ok) {
            emitGameError(socket, result.error, 'INVALID_MOVE');
            emitState(game);
            return;
        }

        game.state = result.state;
        game.updatedAt = Date.now();
        emitState(game);
    });

    socket.on('restartGame', (payload = {}) => {
        const roomId = normalizeRoomId(payload) || socket.data.roomId;
        const game = games.get(roomId);

        if (!game) {
            emitGameError(socket, 'Игра не найдена', 'ROOM_NOT_FOUND');
            return;
        }
        if (!getPlayerId(game, socket.id)) {
            emitGameError(socket, 'Вы не участвуете в этой игре', 'NOT_IN_GAME');
            return;
        }
        if (getStatus(game) === 'waiting') {
            emitGameError(socket, 'Нельзя начать игру без второго игрока', 'WAITING_FOR_OPPONENT');
            return;
        }
        game.state = GameRules.createInitialState();
        game.updatedAt = Date.now();
        emitState(game);
    });

    socket.on('leaveGame', () => {
        leaveCurrentGame(socket, { explicit: true });
    });

    socket.on('disconnect', () => {
        console.log('Игрок отключился: ' + socket.id);
        leaveCurrentGame(socket, { explicit: false, disconnected: true });
    });
});

const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const game of games.values()) {
        const status = getStatus(game);
        const hasConnectedPlayer = ['X', 'O'].some((playerId) => {
            const player = game.players[playerId];
            return Boolean(player && player.socketId);
        });
        const ttl = status === 'waiting' ? WAITING_ROOM_TTL_MS : INACTIVE_ROOM_TTL_MS;

        if (!hasConnectedPlayer && now - game.updatedAt > ttl) {
            closeGame(game, 'Сохранённая партия закрыта из-за долгого отсутствия.');
        }
    }
}, 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Сервер запущен на порту ' + PORT);
});
