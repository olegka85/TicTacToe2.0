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
            if (!features.includes('async-turns-v1')) {
                throw new Error('asynchronous-turn deployment is not active yet');
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

    let creator = await connectClient('creator');
    let guest = null;
    let returningCreator = null;
    let returningGuest = null;

    try {
        const waitingPromise = waitForState(
            creator,
            (payload) => payload && payload.status === 'waiting' && payload.playerId === 'O',
            'create room'
        );
        creator.emit('createGame');
        const waiting = await waitingPromise;
        const roomId = waiting.roomId;
        assert.match(roomId, /^[A-Z2-9]{6}$/);
        assert.ok(waiting.sessionToken);
        console.log('✓ room created: ' + roomId);

        creator.close();
        creator = null;
        await delay(250);
        console.log('✓ creator closed app before invitee joined');

        guest = await connectClient('guest');
        const guestStartedPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === roomId &&
                payload.status === 'playing' &&
                payload.playerId === 'X' &&
                payload.players.connected.O === false,
            'invitee starts while creator offline'
        );
        guest.emit('joinGame', { roomId });
        const guestStarted = await guestStartedPromise;
        assert.strictEqual(guestStarted.state.currentPlayer, 'X');
        assert.ok(guestStarted.sessionToken);
        console.log('✓ invitee joined as X and owns first move while creator offline');

        const firstMovePromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O',
            'offline-opponent first move'
        );
        guest.emit('makeMove', { roomId, boardIndex: 4, cellIndex: 7 });
        await firstMovePromise;
        console.log('✓ invitee moved while creator was offline');

        returningCreator = await connectClient('returning creator');
        const creatorResumePromise = waitForState(
            returningCreator,
            (payload) => payload && payload.roomId === roomId &&
                payload.playerId === 'O' &&
                payload.state.smallBoards[4][7] === 'X' &&
                payload.state.currentPlayer === 'O',
            'creator restores guest move'
        );
        returningCreator.emit('resumeGame', {
            roomId,
            sessionToken: waiting.sessionToken
        });
        const creatorResumed = await creatorResumePromise;
        assert.strictEqual(creatorResumed.state.nextBoard, 7);
        console.log('✓ creator resumed the state made while offline');

        const creatorReplyPromise = waitForState(
            guest,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.smallBoards[7][0] === 'O' &&
                payload.state.currentPlayer === 'X',
            'creator reply reaches guest'
        );
        returningCreator.emit('makeMove', { roomId, boardIndex: 7, cellIndex: 0 });
        await creatorReplyPromise;
        console.log('✓ creator replied after resuming');

        guest.close();
        guest = null;
        await delay(250);

        returningGuest = await connectClient('returning guest');
        const guestResumePromise = waitForState(
            returningGuest,
            (payload) => payload && payload.roomId === roomId &&
                payload.playerId === 'X' &&
                payload.state.smallBoards[4][7] === 'X' &&
                payload.state.smallBoards[7][0] === 'O' &&
                payload.state.currentPlayer === 'X',
            'guest restores exact board'
        );
        returningGuest.emit('resumeGame', {
            roomId,
            sessionToken: guestStarted.sessionToken
        });
        const guestResumed = await guestResumePromise;
        assert.strictEqual(guestResumed.state.nextBoard, 0);
        console.log('✓ invitee resumed exact saved game state');

        const resumedMovePromise = waitForState(
            returningCreator,
            (payload) => payload && payload.roomId === roomId &&
                payload.state.smallBoards[0][1] === 'X' &&
                payload.state.currentPlayer === 'O',
            'resumed invitee move'
        );
        returningGuest.emit('makeMove', { roomId, boardIndex: 0, cellIndex: 1 });
        await resumedMovePromise;
        console.log('✓ play continues after both app-close/resume cycles');

        console.log('PRODUCTION ASYNC MULTIPLAYER SMOKE PASSED');
    } finally {
        if (creator) creator.close();
        if (guest) guest.close();
        if (returningCreator) {
            returningCreator.emit('leaveGame');
            returningCreator.close();
        }
        if (returningGuest) {
            returningGuest.emit('leaveGame');
            returningGuest.close();
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
