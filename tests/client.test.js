'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GameRules = require('../server/game-rules');
const appSource = fs.readFileSync(process.env.APP_SOURCE || path.join(__dirname, '../app.js'), 'utf8');

// Exercise the actual client with a small DOM/socket/animation-clock adapter.
function client({ reducedMotion = false } = {}) {
    const elements = new Map();
    const frames = new Map();
    const resizeListeners = new Set();
    const events = new Map();
    const emitted = [];
    let now = 0;
    let frameId = 0;
    let points = [];
    const drawing = {
        setTransform() {}, save() {}, restore() {}, rotate() {}, beginPath() {},
        arc() {}, fill() {}, fillRect() {},
        clearRect() { points = []; },
        translate(x, y) { points.push({ x, y }); }
    };
    function element() {
        const node = {
            children: [], className: '', style: {}, textContent: '', value: '',
            setAttribute() {}, addEventListener() {}, focus() {},
            appendChild(child) { this.children.push(child); },
            getBoundingClientRect() { return { left: 80, top: 180, width: 100, height: 100 }; },
            getContext() { return drawing; }
        };
        Object.defineProperty(node, 'id', { set(id) { elements.set(id, node); } });
        node.classList = {
            add(...classes) { node.className += ' ' + classes.join(' '); },
            contains(name) { return node.className.split(/\s+/).includes(name); }
        };
        return node;
    }
    for (const [, id] of fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
        element().id = id;
    }
    const socket = {
        connected: true,
        on(name, fn) { events.set(name, fn); },
        emit(name, payload) { emitted.push({ name, payload }); }
    };
    const context = vm.createContext({
        GameRules, console, URLSearchParams,
        Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
        document: { getElementById: id => elements.get(id), createElement: element },
        window: {
            location: { search: '', hostname: 'localhost' },
            innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
            matchMedia: () => ({ matches: reducedMotion }),
            addEventListener: (name, fn) => resizeListeners.add(fn),
            removeEventListener: (name, fn) => resizeListeners.delete(fn)
        },
        io: () => socket,
        performance: { now: () => now },
        requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
        cancelAnimationFrame(id) { frames.delete(id); }
    });
    const run = code => vm.runInContext(code, context);
    function tick(time) {
        now = time;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(time);
    }
    return {
        run, tick, elements, frames, resizeListeners, emitted,
        get points() { return points; },
        send(payload) { events.get('gameState')(payload); },
        boot() { vm.runInContext(appSource, context); }
    };
}
const xMoves = [[0, 1], [1, 0], [0, 2], [2, 0], [0, 0]];
const oMoves = [[8, 4], [4, 0], [0, 4], [4, 1], [1, 4], [4, 2]];
function wonState(moves) {
    return moves.reduce((state, [board, cell]) => {
        const result = GameRules.applyMove(state, board, cell, state.currentPlayer);
        assert.equal(result.ok, true);
        return result.state;
    }, GameRules.createInitialState());
}
function winLocally(c, moves = xMoves) {
    c.run('startLocalGame()');
    for (const [board, cell] of moves) c.run(`makeMove(${board}, ${cell})`);
}
function count(c, className) {
    return [...c.elements.values()].filter(node => node.classList.contains(className)).length;
}

for (const [winner, moves] of [['X', xMoves], ['O', oMoves]]) {
    test(`${winner} victory highlights its board and line, blocks moves, and restarts cleanly`, () => {
        const c = client(); c.boot(); winLocally(c, moves);
        assert.match(c.elements.get('message').textContent, new RegExp(`Победил ${winner}`));
        assert.equal(count(c, 'winning-board'), 1);
        assert.equal(count(c, 'muted-board'), 8);
        assert.equal(count(c, 'winning-cell'), 3);
        const state = c.run('JSON.stringify(gameState)');
        c.run('makeMove(8, 8)');
        assert.equal(c.run('JSON.stringify(gameState)'), state);
        c.tick(100);
        assert.ok(c.points.length > 180);
        c.run('restartGame()');
        assert.equal(c.run('gameState.gameActive'), true);
        assert.equal(count(c, 'taken'), 0);
        assert.equal(count(c, 'winning-board'), 0);
        assert.equal(count(c, 'muted-board'), 0);
        assert.equal(c.frames.size, 0);
        assert.equal(c.resizeListeners.size, 0);
        assert.equal(c.elements.get('confettiCanvas').style.display, 'none');
    });
}

test('online remote restart re-arms the same winner for both players without replaying duplicates', () => {
    for (const playerId of ['X', 'O']) {
        const c = client(); c.boot(); c.run('initSocket()');
        const payload = { roomId: 'ABCDEF', playerId, status: 'finished', state: wonState(xMoves) };
        c.send(payload); c.tick(100);
        assert.equal(c.frames.size, 1);
        const frame = [...c.frames.keys()][0];
        c.send(payload);
        assert.equal([...c.frames.keys()][0], frame);
        // The other player restarted: this client never calls restartGame().
        c.send({ ...payload, status: 'playing', state: GameRules.createInitialState() });
        assert.equal(c.frames.size, 0);
        assert.equal(count(c, 'muted-board'), 0);
        c.send(payload); c.tick(200);
        assert.equal(c.frames.size, 1);
        assert.equal(c.resizeListeners.size, 1);
        assert.ok(c.points.length > 180);
        c.run('restartGame()');
        assert.deepEqual(JSON.parse(JSON.stringify(c.emitted.at(-1))), { name: 'restartGame', payload: { roomId: 'ABCDEF' } });
    }
});

test('confetti trajectory and lifetime use elapsed time at 30/60/120 Hz', () => {
    const positions = [];
    const endTimes = [];
    for (const fps of [30, 60, 120]) {
        const c = client(); c.boot(); winLocally(c);
        let frame = 0;
        for (; frame < fps; frame++) c.tick((frame + 1) * 1000 / fps);
        positions.push(c.points[0]);
        for (; frame < fps * 5.2; frame++) c.tick((frame + 1) * 1000 / fps);
        assert.equal(c.frames.size, 1, `effect ended too early at ${fps} Hz`);
        for (; c.frames.size && frame < fps * 15; frame++) c.tick((frame + 1) * 1000 / fps);
        assert.equal(c.frames.size, 0);
        assert.equal(c.resizeListeners.size, 0);
        endTimes.push(frame / fps);
    }
    for (const position of positions) {
        assert.ok(Math.abs(position.x - positions[0].x) < 1);
        assert.ok(Math.abs(position.y - positions[0].y) < 1);
    }
    assert.ok(Math.max(...endTimes) - Math.min(...endTimes) < 0.4);
});

test('reduced motion still keeps dense top and bottom confetti while shortening the show', () => {
    const c = client({ reducedMotion: true }); c.boot(); winLocally(c);
    assert.equal(c.frames.size, 1);
    assert.equal(count(c, 'winning-board'), 1);
    c.tick(100);
    assert.ok(c.points.length > 150);

    let frame = 6;
    for (; c.frames.size && frame < 60 * 15; frame++) {
        c.tick((frame + 1) * 1000 / 60);
    }
    assert.equal(c.frames.size, 0);
    assert.equal(c.resizeListeners.size, 0);
});

test('returning to menu cancels all celebration work', () => {
    const c = client(); c.boot(); winLocally(c); c.tick(100);
    c.run('exitGame()');
    assert.equal(c.frames.size, 0);
    assert.equal(c.resizeListeners.size, 0);
    assert.equal(c.elements.get('gameContainer').hidden, true);
});
