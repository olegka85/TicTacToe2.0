const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const GameRules = require('./game-rules');

const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'tictactoe-socket' });
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
const WAITING_ROOM_TTL_MS = 30 * 60 * 1000;

function createRoomId() {
    let roomId;
    do {
        roomId = Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('');
    } while (games.has(roomId));
    return roomId;
}

function normalizeRoomId(value) {
    const raw = typeof value === 'string' ? value : value && value.roomId;
    return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function getPlayerId(game, socketId) {
    if (game.players.X === socketId) return 'X';
    if (game.players.O === socketId) return 'O';
    return null;
}

function getStatus(game) {
    if (!game.players.O) return 'waiting';
    if (!game.state.gameActive) return 'finished';
    return 'playing';
}

function buildStatePayload(game, playerId) {
    return {
        roomId: game.id,
        playerId,
        status: getStatus(game),
        players: {
            X: Boolean(game.players.X),
            O: Boolean(game.players.O)
        },
        state: GameRules.cloneState(game.state)
    };
}

function emitState(game) {
    for (const playerId of ['X', 'O']) {
        const socketId = game.players[playerId];
        if (!socketId) continue;
        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerSocket) {
            playerSocket.emit('gameState', buildStatePayload(game, playerId));
        }
    }
}

function emitGameError(socket, message) {
    socket.emit('gameError', { message });
}

function clearSocketRoomData(socket) {
    socket.data.roomId = null;
    socket.data.playerId = null;
}

function leaveCurrentGame(socket, options = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    clearSocketRoomData(socket);
    socket.leave(roomId);

    if (!game) return;

    const playerId = getPlayerId(game, socket.id);
    if (!playerId) return;

    if (playerId === 'X') {
        const opponentSocketId = game.players.O;
        games.delete(roomId);

        if (opponentSocketId) {
            const opponentSocket = io.sockets.sockets.get(opponentSocketId);
            if (opponentSocket) {
                opponentSocket.leave(roomId);
                clearSocketRoomData(opponentSocket);
                opponentSocket.emit('roomClosed', {
                    message: options.disconnected
                        ? 'Создатель комнаты отключился. Комната закрыта.'
                        : 'Создатель комнаты вышел. Комната закрыта.'
                });
            }
        }
        return;
    }

    game.players.O = null;
    game.state = GameRules.createInitialState();
    game.updatedAt = Date.now();

    const creatorSocket = io.sockets.sockets.get(game.players.X);
    if (creatorSocket) {
        creatorSocket.emit('opponentLeft', {
            message: options.disconnected
                ? 'Второй игрок отключился. Ожидание нового игрока.'
                : 'Второй игрок вышел. Ожидание нового игрока.'
        });
    }
    emitState(game);
}

io.on('connection', (socket) => {
    console.log(`Игрок подключился: ${socket.id}`);

    socket.on('createGame', () => {
        leaveCurrentGame(socket);

        const roomId = createRoomId();
        const game = {
            id: roomId,
            players: { X: socket.id, O: null },
            state: GameRules.createInitialState(),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        games.set(roomId, game);
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerId = 'X';
        emitState(game);
        console.log(`Игра создана: ${roomId}`);
    });

    socket.on('joinGame', (payload) => {
        const roomId = normalizeRoomId(payload);
        if (!/^[A-Z2-9]{6}$/.test(roomId)) {
            emitGameError(socket, 'Некорректный код комнаты');
            return;
        }

        const game = games.get(roomId);
        if (!game) {
            emitGameError(socket, 'Игра не найдена');
            return;
        }
        if (game.players.X === socket.id) {
            emitGameError(socket, 'Вы уже создали эту комнату');
            return;
        }
        if (game.players.O && game.players.O !== socket.id) {
            emitGameError(socket, 'Игра уже заполнена');
            return;
        }

        leaveCurrentGame(socket);
        game.players.O = socket.id;
        game.state = GameRules.createInitialState();
        game.updatedAt = Date.now();

        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerId = 'O';

        emitState(game);
        console.log(`Игрок O присоединился к игре: ${roomId}`);
    });

    socket.on('makeMove', (payload = {}) => {
        const roomId = normalizeRoomId(payload);
        const game = games.get(roomId);

        if (!game) {
            emitGameError(socket, 'Игра не найдена');
            return;
        }

        const playerId = getPlayerId(game, socket.id);
        if (!playerId || socket.data.roomId !== roomId) {
            emitGameError(socket, 'Вы не участвуете в этой игре');
            return;
        }
        if (!game.players.O) {
            emitGameError(socket, 'Ожидаем второго игрока');
            return;
        }

        const boardIndex = Number(payload.boardIndex);
        const cellIndex = Number(payload.cellIndex);
        const result = GameRules.applyMove(game.state, boardIndex, cellIndex, playerId);

        if (!result.ok) {
            emitGameError(socket, result.error);
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
            emitGameError(socket, 'Игра не найдена');
            return;
        }
        if (!getPlayerId(game, socket.id)) {
            emitGameError(socket, 'Вы не участвуете в этой игре');
            return;
        }
        if (!game.players.O) {
            emitGameError(socket, 'Нельзя начать игру без второго игрока');
            return;
        }

        game.state = GameRules.createInitialState();
        game.updatedAt = Date.now();
        emitState(game);
    });

    socket.on('leaveGame', () => {
        leaveCurrentGame(socket);
    });

    socket.on('disconnect', () => {
        console.log(`Игрок отключился: ${socket.id}`);
        leaveCurrentGame(socket, { disconnected: true });
    });
});

const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [roomId, game] of games.entries()) {
        if (!game.players.O && now - game.updatedAt > WAITING_ROOM_TTL_MS) {
            const creatorSocket = io.sockets.sockets.get(game.players.X);
            if (creatorSocket) {
                creatorSocket.leave(roomId);
                clearSocketRoomData(creatorSocket);
                creatorSocket.emit('roomClosed', { message: 'Комната закрыта из-за долгого ожидания.' });
            }
            games.delete(roomId);
        }
    }
}, 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
