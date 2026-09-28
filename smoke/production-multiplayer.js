'use strict';

const assert = require('assert');
const { io } = require('socket.io-client');

const SERVER_URL = process.env.SOCKET_URL || 'https://tictactoe-socket-production-7951.up.railway.app';
const TIMEOUT_MS = 15000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(attempts = 36) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(SERVER_URL + '/health', { signal: AbortSignal.timeout(10000) });
            const body = await response.json();
            assert.strictEqual(response.status, 200);
            assert.strictEqual(body.ok, true);
            assert.strictEqual(body.service, 'tictactoe-socket');

            const features = Array.isArray(body.features) ? body.features : [];
            if (!features.includes('session-resume-v1')) {
                throw new Error('new multiplayer deployment is not active yet');
            }

            console.log('✓ health attempt ' + attempt + ': HTTP ' + response.status);
            return;
        } catch (error) {
            lastError = error;
            console.log('health attempt ' + attempt + '/' + attempts + ' failed: ' + error.message);
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
            reject(new Error(label + ': connection timeout'));
        }, TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timer);
            console.log('✓ ' + label + ' connected: ' + socket.id);
            resolve(socket);
        });

        socket.once('connect_error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(new Error(label + ': ' + error.message));
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
    await waitForHealth();

    const creator = await connectClient('creator');
    let guest = await connectClient('guest');
    let returningGuest = null;

    try {
        const waitingPromise = waitForState(
            creator,
            (payload) => payload && payload.status === 'waiting' && payload.playerId === 'O',
            'create room'
        );
        creator.emit('createGame');
        const waiting = await waitingPromise;
        assert.match(waiting.roomId, /^[A-Z2-9]{6}$/);
        assert.ok(waiting.sessionToken);
        const roomId = waiting.roomId;
        console.log('✓ room created: ' + roomId);

        const creatorStartedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === roomId &&
                payload.status === 'playing' && payload.playerId === 'O',
            'creator start state'
        );
        const guestStartedPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === roomId &&
                payload.status === 'playing' && payload.playerId === 'X',
            'guest start state'
        );

        guest.emit('joinGame', { roomId });

        const [creatorStarted, guestStarted] = await Promise.all([
            creatorStartedPromise,
            guestStartedPromise
        ]);
        assert.strictEqual(creatorStarted.state.currentPlayer, 'X');
        assert.strictEqual(guestStarted.state.currentPlayer, 'X');
        assert.ok(guestStarted.sessionToken);
        console.log('✓ invitee joined as X and owns the first move');

        const firstMoveForCreator = waitForState(
            creator,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'O' &&
                payload.state.nextBoard === 7 &&
                payload.state.smallBoards[4][7] === 'X',
            'invitee move echoed to creator'
        );
        const firstMoveForGuest = waitForState(
            guest,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'O' &&
                payload.state.nextBoard === 7 &&
                payload.state.smallBoards[4][7] === 'X',
            'invitee move echoed to guest'
        );

        guest.emit('makeMove', { roomId, boardIndex: 4, cellIndex: 7 });
        await Promise.all([firstMoveForCreator, firstMoveForGuest]);
        console.log('✓ first move synchronized to both players');

        const pausedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === roomId && payload.status === 'paused',
            'creator paused state'
        );
        guest.close();
        await pausedPromise;
        console.log('✓ disconnect pauses rather than destroys the game');

        returningGuest = await connectClient('returning guest');

        const creatorResumedPromise = waitForState(
            creator,
            (payload) => payload && payload.roomId === roomId &&
                payload.status === 'playing' &&
                payload.state.smallBoards[4][7] === 'X',
            'creator sees resumed game'
        );
        const guestResumedPromise = waitForState(
            returningGuest,
            (payload) => payload && payload.roomId === roomId &&
                payload.status === 'playing' &&
                payload.playerId === 'X' &&
                payload.state.smallBoards[4][7] === 'X',
            'guest resume state'
        );

        returningGuest.emit('resumeGame', {
            roomId,
            sessionToken: guestStarted.sessionToken
        });

        const [, resumed] = await Promise.all([creatorResumedPromise, guestResumedPromise]);
        assert.strictEqual(resumed.state.currentPlayer, 'O');
        assert.strictEqual(resumed.state.nextBoard, 7);
        console.log('✓ guest resumed the exact saved game state');

        const secondMoveForCreator = waitForState(
            creator,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'X' &&
                payload.state.nextBoard === 0 &&
                payload.state.smallBoards[7][0] === 'O',
            'creator move echoed'
        );
        const secondMoveForGuest = waitForState(
            returningGuest,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.currentPlayer === 'X' &&
                payload.state.nextBoard === 0 &&
                payload.state.smallBoards[7][0] === 'O',
            'creator move echoed to guest'
        );

        creator.emit('makeMove', { roomId, boardIndex: 7, cellIndex: 0 });
        await Promise.all([secondMoveForCreator, secondMoveForGuest]);
        console.log('✓ play continues after resume');

        console.log('PRODUCTION MULTIPLAYER SMOKE PASSED');
    } finally {
        creator.emit('leaveGame');
        if (returningGuest) returningGuest.emit('leaveGame');
        creator.close();
        guest.close();
        if (returningGuest) returningGuest.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
