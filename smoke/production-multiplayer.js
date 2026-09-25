'use strict';

const assert = require('assert');
const { io } = require('socket.io-client');

const SERVER_URL = process.env.SOCKET_URL || 'https://tictactoe-socket-production-7951.up.railway.app';
const TIMEOUT_MS = 15000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(attempts = 12) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(10000) });
            const body = await response.json();
            assert.strictEqual(response.status, 200);
            assert.strictEqual(body.ok, true);
            assert.strictEqual(body.service, 'tictactoe-socket');
            console.log(`✓ health attempt ${attempt}: HTTP ${response.status}`);
            return;
        } catch (error) {
            lastError = error;
            console.log(`health attempt ${attempt}/${attempts} failed: ${error.message}`);
            if (attempt < attempts) await delay(5000);
        }
    }
    throw lastError;
}

function connectClient(label) {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnection: false,
            timeout: TIMEOUT_MS,
            forceNew: true
        });

        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`${label}: connection timeout`));
        }, TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timer);
            console.log(`✓ ${label} connected: ${socket.id}`);
            resolve(socket);
        });

        socket.once('connect_error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(new Error(`${label}: ${error.message}`));
        });
    });
}

function waitForState(socket, predicate, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`${label}: gameState timeout`));
        }, TIMEOUT_MS);

        const onState = (payload) => {
            try {
                if (!predicate(payload)) return;
                cleanup();
                resolve(payload);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };

        const onError = (payload) => {
            cleanup();
            reject(new Error(`${label}: ${payload && payload.message ? payload.message : 'gameError'}`));
        };

        function cleanup() {
            clearTimeout(timer);
            socket.off('gameState', onState);
            socket.off('gameError', onError);
        }

        socket.on('gameState', onState);
        socket.on('gameError', onError);
    });
}

async function main() {
    await waitForHealth();

    const x = await connectClient('X client');
    const o = await connectClient('O client');

    try {
        const waitingPromise = waitForState(
            x,
            (payload) => payload && payload.status === 'waiting' && payload.playerId === 'X',
            'create room'
        );
        x.emit('createGame');
        const waiting = await waitingPromise;
        assert.match(waiting.roomId, /^[A-Z2-9]{6}$/);
        const roomId = waiting.roomId;
        console.log(`✓ room created: ${roomId}`);

        const xStartedPromise = waitForState(
            x,
            (payload) => payload && payload.roomId === roomId && payload.status === 'playing',
            'X start state'
        );
        const oStartedPromise = waitForState(
            o,
            (payload) => payload && payload.roomId === roomId && payload.status === 'playing' && payload.playerId === 'O',
            'O start state'
        );
        o.emit('joinGame', { roomId });

        const [xStarted, oStarted] = await Promise.all([xStartedPromise, oStartedPromise]);
        assert.strictEqual(xStarted.state.currentPlayer, 'X');
        assert.strictEqual(oStarted.state.currentPlayer, 'X');
        console.log('✓ both players entered playing state');

        const xMoveForX = waitForState(
            x,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'O' &&
                payload.state.nextBoard === 7 &&
                payload.state.smallBoards[4][7] === 'X',
            'X move echoed to X'
        );
        const xMoveForO = waitForState(
            o,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'O' &&
                payload.state.nextBoard === 7 &&
                payload.state.smallBoards[4][7] === 'X',
            'X move echoed to O'
        );
        x.emit('makeMove', { roomId, boardIndex: 4, cellIndex: 7 });
        await Promise.all([xMoveForX, xMoveForO]);
        console.log('✓ X move synchronized to both players');

        const oMoveForX = waitForState(
            x,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'X' &&
                payload.state.nextBoard === 0 &&
                payload.state.smallBoards[7][0] === 'O',
            'O move echoed to X'
        );
        const oMoveForO = waitForState(
            o,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'X' &&
                payload.state.nextBoard === 0 &&
                payload.state.smallBoards[7][0] === 'O',
            'O move echoed to O'
        );
        o.emit('makeMove', { roomId, boardIndex: 7, cellIndex: 0 });
        await Promise.all([oMoveForX, oMoveForO]);
        console.log('✓ O move synchronized to both players');

        console.log('PRODUCTION MULTIPLAYER SMOKE PASSED');
    } finally {
        x.emit('leaveGame');
        o.emit('leaveGame');
        x.close();
        o.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
