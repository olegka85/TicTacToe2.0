(function attachGameRules(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.GameRules = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGameRules() {
    'use strict';

    const WIN_PATTERNS = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];

    function createInitialState() {
        return {
            bigBoard: Array(9).fill(null),
            smallBoards: Array.from({ length: 9 }, () => Array(9).fill(null)),
            currentPlayer: 'X',
            nextBoard: null,
            gameActive: true,
            winner: null
        };
    }

    function cloneState(state) {
        return {
            bigBoard: state.bigBoard.slice(),
            smallBoards: state.smallBoards.map((board) => board.slice()),
            currentPlayer: state.currentPlayer,
            nextBoard: state.nextBoard,
            gameActive: state.gameActive,
            winner: state.winner
        };
    }

    function getLineWinner(cells) {
        for (const [a, b, c] of WIN_PATTERNS) {
            if (cells[a] && cells[a] !== 'draw' && cells[a] === cells[b] && cells[a] === cells[c]) {
                return cells[a];
            }
        }
        return null;
    }

    function getSmallBoardResult(board) {
        const winner = getLineWinner(board);
        if (winner) return winner;
        return board.every((cell) => cell !== null) ? 'draw' : null;
    }

    function getBigBoardResult(bigBoard) {
        const winner = getLineWinner(bigBoard);
        if (winner) return winner;
        return bigBoard.every((cell) => cell !== null) ? 'draw' : null;
    }

    function normalizeNextBoard(state) {
        if (
            state.nextBoard !== null &&
            (!Number.isInteger(state.nextBoard) || state.nextBoard < 0 || state.nextBoard > 8 || state.bigBoard[state.nextBoard] !== null)
        ) {
            return null;
        }
        return state.nextBoard;
    }

    function validateMove(state, boardIndex, cellIndex, player) {
        if (!state || !Array.isArray(state.bigBoard) || !Array.isArray(state.smallBoards)) {
            return 'Некорректное состояние игры';
        }
        if (!state.gameActive) return 'Игра уже завершена';
        if (player !== 'X' && player !== 'O') return 'Некорректный игрок';
        if (state.currentPlayer !== player) return 'Сейчас не ваш ход';
        if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex > 8) return 'Некорректное поле';
        if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) return 'Некорректная клетка';
        if (!Array.isArray(state.smallBoards[boardIndex]) || state.smallBoards[boardIndex].length !== 9) {
            return 'Повреждено состояние игрового поля';
        }
        if (state.bigBoard[boardIndex] !== null) return 'Это малое поле уже завершено';

        const requiredBoard = normalizeNextBoard(state);
        if (requiredBoard !== null && requiredBoard !== boardIndex) {
            return `Нужно ходить в поле ${requiredBoard + 1}`;
        }
        if (state.smallBoards[boardIndex][cellIndex] !== null) return 'Клетка занята';
        return null;
    }

    function applyMove(state, boardIndex, cellIndex, player) {
        const error = validateMove(state, boardIndex, cellIndex, player);
        if (error) {
            return { ok: false, error, state };
        }

        const nextState = cloneState(state);
        nextState.nextBoard = normalizeNextBoard(nextState);
        nextState.smallBoards[boardIndex][cellIndex] = player;

        const smallResult = getSmallBoardResult(nextState.smallBoards[boardIndex]);
        if (smallResult !== null) {
            nextState.bigBoard[boardIndex] = smallResult;
        }

        const bigResult = getBigBoardResult(nextState.bigBoard);
        if (bigResult !== null) {
            nextState.gameActive = false;
            nextState.winner = bigResult;
            nextState.nextBoard = null;
            return {
                ok: true,
                state: nextState,
                move: { boardIndex, cellIndex, player, smallResult, bigResult }
            };
        }

        nextState.nextBoard = nextState.bigBoard[cellIndex] === null ? cellIndex : null;
        nextState.currentPlayer = player === 'X' ? 'O' : 'X';

        return {
            ok: true,
            state: nextState,
            move: { boardIndex, cellIndex, player, smallResult, bigResult: null }
        };
    }

    return {
        WIN_PATTERNS,
        createInitialState,
        cloneState,
        getSmallBoardResult,
        getBigBoardResult,
        validateMove,
        applyMove
    };
});
