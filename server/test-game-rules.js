const assert = require('assert');
const GameRules = require('./game-rules');

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}`);
        throw error;
    }
}

test('initial state is a 9x9 board', () => {
    const state = GameRules.createInitialState();
    assert.strictEqual(state.smallBoards.length, 9);
    assert.ok(state.smallBoards.every((board) => board.length === 9));
    assert.deepStrictEqual(state.bigBoard, Array(9).fill(null));
    assert.strictEqual(state.currentPlayer, 'X');
    assert.strictEqual(state.nextBoard, null);
});

test('a move routes the opponent to the matching small board', () => {
    const state = GameRules.createInitialState();
    const result = GameRules.applyMove(state, 4, 7, 'X');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.smallBoards[4][7], 'X');
    assert.strictEqual(result.state.nextBoard, 7);
    assert.strictEqual(result.state.currentPlayer, 'O');
});

test('a move on the wrong routed board is rejected', () => {
    let state = GameRules.createInitialState();
    state = GameRules.applyMove(state, 4, 7, 'X').state;
    const result = GameRules.applyMove(state, 3, 0, 'O');
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /поле 8/);
});

test('winning one small board immediately ends the whole game', () => {
    const state = GameRules.createInitialState();
    state.currentPlayer = 'X';
    state.smallBoards[2][0] = 'X';
    state.smallBoards[2][1] = 'X';
    const result = GameRules.applyMove(state, 2, 2, 'X');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.bigBoard[2], 'X');
    assert.strictEqual(result.state.gameActive, false);
    assert.strictEqual(result.state.winner, 'X');
    assert.strictEqual(result.state.nextBoard, null);
});

test('routing to an already finished small board allows any unfinished board', () => {
    const state = GameRules.createInitialState();
    state.currentPlayer = 'X';
    state.bigBoard[5] = 'O';
    const result = GameRules.applyMove(state, 1, 5, 'X');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.nextBoard, null);
});

test('an O line in a small board also ends the match immediately', () => {
    const state = GameRules.createInitialState();
    state.currentPlayer = 'O';
    state.smallBoards[4][2] = 'O';
    state.smallBoards[4][5] = 'O';
    const result = GameRules.applyMove(state, 4, 8, 'O');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.bigBoard[4], 'O');
    assert.strictEqual(result.state.gameActive, false);
    assert.strictEqual(result.state.winner, 'O');
    assert.strictEqual(result.state.nextBoard, null);
});

test('resolved small board cannot be played again', () => {
    const state = GameRules.createInitialState();
    state.bigBoard[3] = 'draw';
    const result = GameRules.applyMove(state, 3, 4, 'X');
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /завершено/);
});

console.log('All game rule tests passed.');
