'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GameRules = require('../server/game-rules');
const appSource = fs.readFileSync(process.env.APP_SOURCE || path.join(__dirname, '../app.js'), 'utf8');

// Exercise the actual client with a small DOM/socket/animation-clock adapter.
function client({ reducedMotion = false, botUsername = 'tictactoe_test_bot', sharedStorage = null } = {}) {
    const elements = new Map();
    const frames = new Map();
    const resizeListeners = new Set();
    const events = new Map();
    const windowEvents = new Map();
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
        GameRules, console, URL, URLSearchParams,
        ...(sharedStorage ? { localStorage: sharedStorage } : {}),
        Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
        document: { getElementById: id => elements.get(id), createElement: element },
        window: {
            TICTACTOE_TELEGRAM_BOT_USERNAME: botUsername,
            location: { search: '', hash: '', hostname: 'localhost', pathname: '/', origin: 'http://localhost' },
            innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
            matchMedia: () => ({ matches: reducedMotion }),
            addEventListener: (name, fn) => {
                if (name === 'resize') resizeListeners.add(fn);
                const list = windowEvents.get(name) || [];
                list.push(fn);
                windowEvents.set(name, list);
            },
            dispatchEvent: event => {
                for (const callback of windowEvents.get(event.type) || []) callback(event);
            },
            removeEventListener: (name, fn) => { if (name === 'resize') resizeListeners.delete(fn); }
        },
        io: () => socket,
        performance: { now: () => now },
        // The production client uses an interval for the online next-round countdown.
        // Client tests advance animation frames manually; no wall-clock timer is needed.
        setInterval() { return 1; },
        clearInterval() {},
        setTimeout, clearTimeout,
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


test('Telegram user invitations bypass BotFather startapp and target the game room directly', () => {
    const c = client();
    c.run("window.Telegram = { WebApp: { initData: 'fixture', ready() {}, expand() {} } }");
    c.boot();
    c.run("roomId = 'ABCDEF'");
    assert.equal(c.run('buildInviteUrl()'), 'http://localhost/?room=ABCDEF');
    assert.doesNotMatch(c.run('buildInviteUrl()'), /t\\.me/);
});

test('web browser invite stays on the current website', () => {
    const c = client(); c.boot();
    c.run("roomId = 'ABCDEF'");
    assert.equal(c.run('buildInviteUrl()'), 'http://localhost/?room=ABCDEF');
});

test('invite without a bot username still works on the website', () => {
    const c = client({ botUsername: '' }); c.boot();
    c.run("roomId = 'ABCDEF'");
    assert.equal(c.run('buildInviteUrl()'), 'http://localhost/?room=ABCDEF');
});


test('quick rules are accessible from the main screen and describe real gameplay', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    assert.match(html, /<details id="gameRules" class="rules">/);
    assert.match(html, /<summary>📖 Как играть/);
    assert.match(html, /Поле 9×9 состоит из девяти маленьких полей 3×3/);
    assert.match(html, /Выбранная клетка определяет/);
    assert.match(html, /можно выбрать любое незавершённое поле/);
    assert.match(html, /3 своих знака в ряд в любом маленьком поле/);
    assert.match(html, /Новые раунды начинаются сами/);
});


test('Telegram startapp invitation in URL fragment joins room on first opening', async () => {
    const c = client();
    c.run("window.location.hash = '#tgWebAppStartParam=room_S68N7E&tgWebAppPlatform=android'");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    const actions = c.emitted.filter(x => x.name === 'joinGame' || x.name === 'resumeGame');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'joinGame');
    assert.equal(actions[0].payload.roomId, 'S68N7E');
});

test('Telegram startapp invitation from SDK joins room', async () => {
    const c = client();
    c.run("window.Telegram = { WebApp: { initData: 'start_param=room_S68N7E', initDataUnsafe: { start_param: 'room_S68N7E', user: { id: 456 } }, ready() {}, expand() {} } }");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'S68N7E'));
});

test('Telegram invite ignores saved room belonging to another account', async () => {
    const oldSession = JSON.stringify({ roomId: 'S68N7E', sessionToken: 'token-from-other-telegram-account', playerId: 'O' });
    const keys = new Map([['tictactoe.onlineSession.v1.tg.111', oldSession]]);
    const storage = {
        getItem: key => keys.get(key) || null,
        setItem: (key, value) => keys.set(key, value),
        removeItem: key => keys.delete(key)
    };
    const c = client({ sharedStorage: storage });
    c.run("window.Telegram = { WebApp: { initData: 'fixture', initDataUnsafe: { user: { id: 222 }, start_param: 'room_S68N7E' }, ready() {}, expand() {} } }");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'S68N7E'));
    assert.ok(!c.emitted.some(x => x.name === 'resumeGame'));
    assert.equal(keys.get('tictactoe.onlineSession.v1.tg.111'), oldSession);
});

test('Telegram creator resumes own saved room rather than joining as second player', async () => {
    const oldSession = JSON.stringify({ roomId: 'S68N7E', sessionToken: 'creator-secret-session-token', playerId: 'O' });
    const keys = new Map([['tictactoe.onlineSession.v1.tg.111', oldSession]]);
    const storage = {
        getItem: key => keys.get(key) || null,
        setItem: (key, value) => keys.set(key, value),
        removeItem: key => keys.delete(key)
    };
    const c = client({ sharedStorage: storage });
    c.run("window.Telegram = { WebApp: { initData: 'fixture', initDataUnsafe: { user: { id: 111 }, start_param: 'room_S68N7E' }, ready() {}, expand() {} } }");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'resumeGame' && x.payload.roomId === 'S68N7E'));
    assert.ok(!c.emitted.some(x => x.name === 'joinGame'));
});

test('Telegram invite joins immediately even if CloudStorage never calls back', async () => {
    const c = client();
    c.run("window.location.hash = '#tgWebAppStartParam=room_S68N7E&tgWebAppPlatform=android'");
    c.run("window.Telegram = { WebApp: { initData: 'fixture', initDataUnsafe: { user: { id: 999 } }, CloudStorage: { getItem(_key,_cb) {} }, ready() {}, expand() {} } }");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.emitted.filter(x => x.name === 'joinGame').length, 1);
    assert.equal(c.emitted.find(x => x.name === 'joinGame').payload.roomId, 'S68N7E');
    assert.equal(c.emitted.filter(x => x.name === 'resumeGame').length, 0);
});

test('Main Mini App supports startapp query on direct WebView URL', async () => {
    const c = client();
    c.run("window.location.search = '?startapp=room_S68N7E'");
    // SEARCH_PARAMS is initialized during boot, after location.search is set.
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'S68N7E'));
});

test('Invitation link from Telegram works when SDK has no initData', () => {
    const c = client();
    c.run("window.Telegram = { WebApp: { initData: '', ready() {}, expand() {} } }");
    c.boot();
    c.run("roomId = 'S68N7E'");
    assert.equal(c.run('buildInviteUrl()'), 'http://localhost/?room=S68N7E');
});

test('A code entered manually starts joining the selected room', async () => {
    const c = client(); c.boot();
    c.elements.get('roomCodeInput').value = 's68n7e';
    c.run('joinRoomFromCode()');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'S68N7E'));
});

test('room invite URL auto-joins for a first-time user without Telegram SDK or bot start', async () => {
    const c = client();
    c.run("window.location.search = '?room=7HDT4D'");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    const joins = c.emitted.filter(x => x.name === 'joinGame');
    assert.equal(joins.length, 1);
    assert.equal(joins[0].payload.roomId, '7HDT4D');
    assert.equal(c.emitted.filter(x => x.name === 'resumeGame').length, 0);
});

test('room invite URL prioritizes requested room over old saved game', async () => {
    const keys = new Map([['tictactoe.onlineSession.v1', JSON.stringify({
        roomId: 'OTHER1', sessionToken: 'existing-session-token-long', playerId: 'O'
    })]]);
    const storage = {
        getItem: key => keys.get(key) || null,
        setItem: (key, value) => keys.set(key, value),
        removeItem: key => keys.delete(key)
    };
    const c = client({ sharedStorage: storage });
    c.run("window.location.search = '?room=7HDT4D'");
    c.boot();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === '7HDT4D'));
    assert.ok(!c.emitted.some(x => x.name === 'resumeGame'));
});

// The Telegram CDN may be blocked or slow in some networks. Loading the
// Telegram SDK synchronously freezes HTML parsing before app.js can join.
test('Telegram SDK never blocks initial game client bootstrap', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    assert.match(html, /<script async src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"/);
    assert.match(html, /onload="window\.dispatchEvent\(/);
    assert.ok(html.indexOf('telegram-web-app.js') < html.indexOf('app.js?v='));
});

test('Telegram startapp link has room code and the website link remains available', () => {
    const c = client(); c.boot();
    c.run("roomId = 'QPK96M'");
    assert.equal(c.run('buildTelegramInviteUrl()'), 'https://t.me/tictactoe_test_bot?startapp=room_QPK96M');
    assert.equal(c.run('buildInviteUrl()'), 'http://localhost/?room=QPK96M');
});

test('Telegram SDK without start_param displays visible manual room entry and safe diagnostics', () => {
    const c = client();
    c.run("window.Telegram = { WebApp: { initData: '', platform: 'android', initDataUnsafe: {}, ready() {}, expand() {} } }");
    c.boot();
    assert.equal(c.elements.get('telegramLaunchHelp').hidden, false);
    assert.equal(c.elements.get('telegramDebugDetails').hidden, false);
    assert.match(c.elements.get('telegramDebugOutput').textContent, /"requestedRoom": "missing"/);
    assert.doesNotMatch(c.elements.get('telegramDebugOutput').textContent, /hash=|signature=|auth_date=/);
    c.elements.get('telegramRoomCodeInput').value = 'qpk96m';
    c.run('joinTelegramFallbackCode()');
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'QPK96M'));
});

test('Telegram startapp carried inside nested tgWebAppData is extracted', () => {
    const c = client();
    c.run("window.location.hash = '#tgWebAppData=start_param%3Droom_QPK96M%26auth_date%3D1&tgWebAppPlatform=android'");
    c.boot();
    assert.equal(c.run('getInviteRoomId()'), 'QPK96M');
    assert.equal(c.elements.get('telegramLaunchHelp').hidden, true);
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'QPK96M'));
});

test('late-loaded Telegram SDK can override older saved room with a newly received invitation', async () => {
    const keys = new Map([['tictactoe.onlineSession.v1.tg.123', JSON.stringify({
        roomId: 'OTHER1', sessionToken: 'old-session-long-enough', playerId: 'O'
    })]]);
    const storage = {
        getItem: key => keys.get(key) || null,
        setItem: (key, value) => keys.set(key, value),
        removeItem: key => keys.delete(key)
    };
    const c = client({ sharedStorage: storage });
    c.boot();
    c.run("window.Telegram = { WebApp: { initData: '', initDataUnsafe: { user: { id: 123 }, start_param: 'room_QPK96M' }, platform: 'android', ready() {}, expand() {} } }");
    c.run("window.dispatchEvent({type:'ttt-telegram-sdk-loaded'})");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.emitted.some(x => x.name === 'joinGame' && x.payload.roomId === 'QPK96M'));
});

test('Telegram client release includes boot diagnosis but not sensitive initData', () => {
    const c = client();
    c.run("window.Telegram = { WebApp: { initData: 'start_param=room_QPK96M&hash=secret-hash&auth_date=123', initDataUnsafe: { start_param: 'room_QPK96M' }, platform: 'android', ready() {}, expand() {} } }");
    c.boot();
    const diag = c.run('JSON.stringify(launchDiagnostics())');
    assert.ok(diag.includes('QPK96M'));
    assert.ok(diag.includes('"bridgeStart":true'));
    assert.ok(!diag.includes('secret-hash'));
    assert.ok(!diag.includes('auth_date'));
});
