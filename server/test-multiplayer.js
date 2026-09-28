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
        assert.ok(health.features.includes('async-turns-v1'));

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

        // The creator may close Telegram/the browser before the invitee opens the link.
        creator.close();
        await delay(50);

        const guest = await connectClient('guest');
        sockets.push(guest);

        const guestStartedPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.status === 'playing' && payload.playerId === 'X',
            'guest playing while creator offline'
        );
        guest.emit('joinGame', { roomId: waiting.roomId });
        const guestStarted = await guestStartedPromise;

        assert.strictEqual(guestStarted.state.currentPlayer, 'X');
        assert.strictEqual(guestStarted.players.connected.O, false);
        assert.ok(guestStarted.sessionToken);

        // The invitee owns the first move even while the creator is offline.
        const guestAfterFirstMove = waitForState(
            guest,
            (payload) => payload && payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O' &&
                payload.players.connected.O === false,
            'guest first move while creator offline'
        );
        guest.emit('makeMove', { roomId: waiting.roomId, boardIndex: 4, cellIndex: 7 });
        await guestAfterFirstMove;

        const returningCreator = await connectClient('returning creator');
        sockets.push(returningCreator);

        const creatorResumedPromise = waitForState(
            returningCreator,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.status === 'playing' &&
                payload.playerId === 'O' &&
                payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O',
            'creator resumes after guest move'
        );
        const guestSeesCreatorPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.players.connected.O === true,
            'guest sees creator reconnect'
        );

        returningCreator.emit('resumeGame', {
            roomId: waiting.roomId,
            sessionToken: waiting.sessionToken
        });

        const [creatorResumed] = await Promise.all([
            creatorResumedPromise,
            guestSeesCreatorPromise
        ]);
        assert.strictEqual(creatorResumed.state.nextBoard, 7);

        const creatorAfterMove = waitForState(
            returningCreator,
            (payload) => payload && payload.state.smallBoards[7][0] === 'O' &&
                payload.state.currentPlayer === 'X' &&
                payload.state.nextBoard === 0,
            'creator asynchronous reply'
        );
        const guestAfterCreatorMove = waitForState(
            guest,
            (payload) => payload && payload.state.smallBoards[7][0] === 'O' &&
                payload.state.currentPlayer === 'X',
            'guest sees creator reply'
        );

        returningCreator.emit('makeMove', {
            roomId: waiting.roomId,
            boardIndex: 7,
            cellIndex: 0
        });
        await Promise.all([creatorAfterMove, guestAfterCreatorMove]);

        // The guest closes the app; the game remains playable/saved.
        const creatorSeesGuestOffline = waitForState(
            returningCreator,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.status === 'playing' &&
                payload.players.connected.X === false &&
                payload.state.smallBoards[7][0] === 'O',
            'creator sees guest offline without pausing game'
        );
        guest.close();
        await creatorSeesGuestOffline;

        const returningGuest = await connectClient('returning guest');
        sockets.push(returningGuest);

        const guestResumedPromise = waitForState(
            returningGuest,
            (payload) => payload && payload.roomId === waiting.roomId &&
                payload.status === 'playing' &&
                payload.playerId === 'X' &&
                payload.state.smallBoards[4][7] === 'X' &&
                payload.state.smallBoards[7][0] === 'O' &&
                payload.state.currentPlayer === 'X',
            'guest resumes exact saved board'
        );

        returningGuest.emit('resumeGame', {
            roomId: waiting.roomId,
            sessionToken: guestStarted.sessionToken
        });

        const resumedGuest = await guestResumedPromise;
        assert.strictEqual(resumedGuest.state.nextBoard, 0);

        const creatorAfterResumedMove = waitForState(
            returningCreator,
            (payload) => payload && payload.state.smallBoards[0][1] === 'X' &&
                payload.state.currentPlayer === 'O',
            'resumed guest move reaches creator'
        );
        returningGuest.emit('makeMove', {
            roomId: waiting.roomId,
            boardIndex: 0,
            cellIndex: 1
        });
        await creatorAfterResumedMove;

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

        returningCreator.emit('leaveGame');
        returningGuest.emit('leaveGame');

        console.log('All asynchronous multiplayer session tests passed.');
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
