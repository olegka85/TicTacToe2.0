'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 32147;
const SERVER_URL = 'http://127.0.0.1:' + PORT;
const TIMEOUT_MS = 8000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
    let lastError;

    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(SERVER_URL + '/health');
            const body = await response.json();
            if (response.ok && body.ok) return body;
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }

    throw lastError || new Error('Server health timeout');
}

function connectClient(label) {
    return new Promise((resolve, reject) => {
        const socket = io(SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnection: false,
            forceNew: true,
            timeout: TIMEOUT_MS
        });

        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(label + ': connection timeout'));
        }, TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });

        socket.once('connect_error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(error);
        });
    });
}

function waitForState(socket, predicate, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(label + ': gameState timeout'));
        }, TIMEOUT_MS);

        const onState = (payload) => {
            if (!predicate(payload)) return;
            cleanup();
            resolve(payload);
        };

        const onError = (payload) => {
            cleanup();
            reject(new Error(label + ': ' + (payload && payload.message ? payload.message : 'gameError')));
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
    const child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let childOutput = '';
    child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

    const sockets = [];

    try {
        const health = await waitForHealth();
        assert.ok(health.features.includes('session-resume-v1'));

        const creator = await connectClient('creator');
        sockets.push(creator);

        const waitingPromise = waitForState(
            creator,
            (payload) => payload && payload.status === 'waiting' && payload.playerId === 'O',
            'creator waiting'
        );
        creator.emit('createGame');
        const waiting = await waitingPromise;

        assert.match(waiting.roomId, /^[A-Z2-9]{6}$/);
        assert.ok(waiting.sessionToken);
        assert.strictEqual(waiting.state.currentPlayer, 'X');

        const guest = await connectClient('guest');
        sockets.push(guest);

        const creatorStartedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === waiting.roomId && payload.status === 'playing',
            'creator playing'
        );
        const guestStartedPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.status === 'playing' && payload.playerId === 'X',
            'guest playing'
        );

        guest.emit('joinGame', { roomId: waiting.roomId });
        const [creatorStarted, guestStarted] = await Promise.all([creatorStartedPromise, guestStartedPromise]);

        assert.strictEqual(creatorStarted.playerId, 'O');
        assert.strictEqual(guestStarted.playerId, 'X');
        assert.strictEqual(guestStarted.state.currentPlayer, 'X');
        assert.ok(guestStarted.sessionToken);

        const creatorAfterMove = waitForState(
            creator,
            (payload) => payload && payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O',
            'first move for creator'
        );
        const guestAfterMove = waitForState(
            guest,
            (payload) => payload && payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O',
            'first move for guest'
        );

        guest.emit('makeMove', { roomId: waiting.roomId, boardIndex: 4, cellIndex: 7 });
        await Promise.all([creatorAfterMove, guestAfterMove]);

        const pausedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === waiting.roomId && payload.status === 'paused',
            'creator paused after guest disconnect'
        );
        guest.close();
        await pausedPromise;

        const returningGuest = await connectClient('returning guest');
        sockets.push(returningGuest);

        const creatorResumedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === waiting.roomId && payload.status === 'playing' &&
                payload.state.smallBoards[4][7] === 'X',
            'creator sees resumed guest'
        );
        const guestResumedPromise = waitForState(
            returningGuest,
            (payload) => payload && payload.roomId === waiting.roomId && payload.status === 'playing' &&
                payload.playerId === 'X' && payload.state.smallBoards[4][7] === 'X',
            'guest resumes saved state'
        );

        returningGuest.emit('resumeGame', {
            roomId: waiting.roomId,
            sessionToken: guestStarted.sessionToken
        });

        const [, resumedGuest] = await Promise.all([creatorResumedPromise, guestResumedPromise]);
        assert.strictEqual(resumedGuest.state.currentPlayer, 'O');
        assert.strictEqual(resumedGuest.state.nextBoard, 7);

        const invalidSessionError = new Promise((resolve, reject) => {
            const attacker = io(SERVER_URL, {
                transports: ['websocket'],
                reconnection: false,
                forceNew: true,
                timeout: TIMEOUT_MS
            });
            sockets.push(attacker);

            const timer = setTimeout(() => {
                attacker.close();
                reject(new Error('invalid session error timeout'));
            }, TIMEOUT_MS);

            attacker.once('connect', () => {
                attacker.emit('resumeGame', {
                    roomId: waiting.roomId,
                    sessionToken: 'not-a-real-session-token'
                });
            });

            attacker.once('gameError', (payload) => {
                clearTimeout(timer);
                try {
                    assert.strictEqual(payload.code, 'INVALID_SESSION');
                    resolve();
                } catch (error) {
                    reject(error);
                } finally {
                    attacker.close();
                }
            });
        });
        await invalidSessionError;

        creator.emit('leaveGame');
        returningGuest.emit('leaveGame');

        console.log('All multiplayer session tests passed.');
    } finally {
        for (const socket of sockets) {
            try { socket.close(); } catch (_error) {}
        }
        child.kill('SIGTERM');
        await delay(100);

        if (child.exitCode && child.exitCode !== 0) {
            throw new Error('Server exited with code ' + child.exitCode + '\n' + childOutput);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
