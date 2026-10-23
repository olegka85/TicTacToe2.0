'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');

const PORT = 32149;
const URL = 'http://127.0.0.1:' + PORT;
const WAIT_MS = 10000;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt20-persist-'));
const DB_PATH = path.join(DATA_DIR, 'rooms.sqlite');
const sockets = [];
let child = null;
let childOutput = '';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
    child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(PORT),
            ROOM_DB_PATH: DB_PATH,
            NEXT_ROUND_DELAY_MS: '1700'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    for (let i = 0; i < 80; i += 1) {
        if (child.exitCode !== null) throw new Error('Server exited: ' + childOutput);
        try {
            const r = await fetch(URL + '/health');
            if (r.ok) {
                const health = await r.json();
                assert.ok(health.features.includes('persistent-rooms-v1'));
                return;
            }
        } catch (_error) {}
        await delay(80);
    }
    throw new Error('Server start timeout: ' + childOutput);
}

async function killServer() {
    if (!child) return;
    const old = child;
    const exited = once(old, 'exit').catch(() => {});
    old.kill('SIGKILL');
    await exited;
    child = null;
}

function connect(label) {
    return new Promise((resolve, reject) => {
        const socket = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
        sockets.push(socket);
        const timer = setTimeout(() => reject(new Error(label + ' connect timeout')), WAIT_MS);
        socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
}

function stateAfter(socket, condition, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clear(); reject(new Error(label + ' timeout')); }, WAIT_MS);
        function clear() {
            clearTimeout(timer);
            socket.off('gameState', onState);
            socket.off('gameError', onError);
        }
        function onState(state) {
            if (!condition(state)) return;
            clear();
            resolve(state);
        }
        function onError(e) {
            clear();
            reject(new Error(label + ': ' + (e.message || JSON.stringify(e))));
        }
        socket.on('gameState', onState);
        socket.on('gameError', onError);
    });
}

async function move(socket, roomId, boardIndex, cellIndex, expectedPlayer, label) {
    const state = stateAfter(socket, (p) => p.state.smallBoards[boardIndex][cellIndex] === expectedPlayer, label);
    socket.emit('makeMove', { roomId, boardIndex, cellIndex });
    return state;
}

async function winInFiveMoves(first, second, roomId, mark, round) {
    let current = await move(first, roomId, 0, 1, mark, 'round '+round+' move1');
    current = await move(second, roomId, 1, 0, mark === 'X' ? 'O' : 'X', 'round '+round+' move2');
    current = await move(first, roomId, 0, 2, mark, 'round '+round+' move3');
    current = await move(second, roomId, 2, 0, mark === 'X' ? 'O' : 'X', 'round '+round+' move4');
    current = await move(first, roomId, 0, 0, mark, 'round '+round+' move5');
    assert.equal(current.state.winner, mark);
    assert.equal(current.status, 'finished');
    assert.equal(current.roundNumber, round);
    assert.ok(current.nextRoundAt > Date.now());
    return current;
}

async function resume(socket, roomId, token, label) {
    const p = stateAfter(socket, (s) => s.roomId === roomId, label);
    socket.emit('resumeGame', { roomId, sessionToken: token });
    return p;
}

async function main() {
    try {
        await startServer();
        const creator = await connect('creator');
        const first = stateAfter(creator, (p) => p.status === 'waiting', 'create');
        creator.emit('createGame');
        const waiting = await first;
        const roomId = waiting.roomId;
        assert.equal(waiting.starter, 'X');
        assert.equal(waiting.roundNumber, 1);
        const guest = await connect('guest');
        const joined = stateAfter(guest, (p) => p.status === 'playing', 'join');
        guest.emit('joinGame', { roomId });
        const play = await joined;
        assert.equal(play.playerId, 'X');
        await move(guest, roomId, 0, 1, 'X', 'first persisted move');
        const saved = await move(creator, roomId, 1, 0, 'O', 'second persisted move');
        assert.equal(saved.state.currentPlayer, 'X');
        assert.ok(fs.statSync(DB_PATH).size > 0);
        console.log('SQLite created and two moves durably committed');

        await killServer();
        await startServer();
        const guestAgain = await connect('guest restored');
        const creatorAgain = await connect('creator restored');
        const [xs, os] = await Promise.all([
            resume(guestAgain, roomId, play.sessionToken, 'guest restored'),
            resume(creatorAgain, roomId, waiting.sessionToken, 'creator restored')
        ]);
        assert.equal(xs.playerId, 'X');
        assert.equal(os.playerId, 'O');
        assert.equal(xs.state.smallBoards[0][1], 'X');
        assert.equal(xs.state.smallBoards[1][0], 'O');
        assert.equal(os.state.currentPlayer, 'X');
        console.log('SIGKILL recovery: same room, both tokens and board retained');

        await move(guestAgain, roomId, 0, 2, 'X', 'move3');
        await move(creatorAgain, roomId, 2, 0, 'O', 'move4');
        const winX = await move(guestAgain, roomId, 0, 0, 'X', 'winX');
        assert.equal(winX.status, 'finished');
        assert.equal(winX.score.X, 1);
        assert.equal(winX.nextRoundAt > Date.now(), true);
        console.log('Round 1: X wins, outcome and next round deadline persisted');

        await killServer();
        await startServer();
        const xFinal = await connect('X after restart');
        const oFinal = await connect('O after restart');
        const [persistX,persistO] = await Promise.all([
            resume(xFinal, roomId, play.sessionToken, 'X after finish'),
            resume(oFinal, roomId, waiting.sessionToken, 'O after finish')
        ]);
        assert.equal(persistX.score.X, 1);
        assert.equal(persistO.score.X, 1);
        const oRound2 = stateAfter(oFinal, (s) => s.roundNumber === 2 && s.status === 'playing', 'automatic round 2');
        // If the deadline elapsed before resumption, recheck via state event below
        const round2 = persistO.roundNumber === 2 ? persistO : await oRound2;
        assert.equal(round2.starter, 'O');
        assert.equal(round2.state.currentPlayer, 'O');
        assert.equal(round2.score.X, 1);
        console.log('Round 2 automatically opened after restart; O moves first');

        const wrongTurn = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('wrong starter check timeout')), WAIT_MS);
            xFinal.once('gameError', (e) => { clearTimeout(timer); resolve(e); });
        });
        xFinal.emit('makeMove', { roomId, boardIndex: 0, cellIndex: 1 });
        const wrong = await wrongTurn;
        assert.equal(wrong.code, 'INVALID_MOVE');
        const winO = await winInFiveMoves(oFinal, xFinal, roomId, 'O', 2);
        assert.deepEqual(winO.score, { X: 1, O: 1, draws: 0 });
        const r3 = stateAfter(xFinal, (s) => s.roundNumber === 3 && s.status === 'playing', 'automatic round 3');
        const third = await r3;
        assert.equal(third.starter, 'X');
        assert.equal(third.state.currentPlayer, 'X');
        assert.deepEqual(third.score, { X: 1, O: 1, draws: 0 });
        console.log('Round 3 automatically opened; X moves first, cumulative score intact');
        console.log('All SQLite persistence, crash recovery, auto rounds and alternating starter tests passed.');
    } finally {
        for (const socket of sockets) socket.close();
        await killServer();
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
