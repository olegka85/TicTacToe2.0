'use strict';

/**
 * A single-process room store. Production uses SQLite on a Docker volume.
 * A missing ROOM_DB_PATH deliberately leaves legacy/test deployments in memory.
 * Socket identifiers must never be persisted: they're short-lived and invalid after restart.
 */
function createRoomStore(filePath = process.env.ROOM_DB_PATH) {
    if (!filePath) {
        return {
            enabled: false,
            load: () => [],
            save: () => {},
            delete: () => {},
            close: () => {}
        };
    }

    // Loaded only for the REG.RU 1 deployment (Node 24+).
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filePath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS game_rooms (
            id TEXT PRIMARY KEY NOT NULL,
            room_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    const saveStatement = db.prepare(`
        INSERT INTO game_rooms (id, room_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE
        SET room_json = excluded.room_json, updated_at = excluded.updated_at
    `);
    const deleteStatement = db.prepare('DELETE FROM game_rooms WHERE id = ?');
    const loadStatement = db.prepare('SELECT id, room_json FROM game_rooms');

    function snapshot(game) {
        return {
            id: game.id,
            players: {
                X: game.players.X ? { sessionToken: game.players.X.sessionToken } : null,
                O: game.players.O ? { sessionToken: game.players.O.sessionToken } : null
            },
            state: game.state,
            roundNumber: game.roundNumber,
            starter: game.starter,
            score: game.score,
            nextRoundAt: game.nextRoundAt,
            createdAt: game.createdAt,
            updatedAt: game.updatedAt
        };
    }

    function load() {
        return loadStatement.all().map(({ id, room_json }) => {
            let game;
            try {
                game = JSON.parse(room_json);
                if (game.id !== id || !/^[A-Z2-9]{6}$/.test(id)) throw new Error('invalid room ID');
                if (!game.players || !game.state || !Array.isArray(game.state.smallBoards) ||
                    game.state.smallBoards.length !== 9 || !Array.isArray(game.state.bigBoard) ||
                    game.state.bigBoard.length !== 9 || !game.players.O ||
                    typeof game.players.O.sessionToken !== 'string') {
                    throw new Error('invalid saved room state');
                }
            } catch (error) {
                throw new Error(`Corrupted saved room ${id}: ${error.message}`);
            }
            for (const player of [game.players.X, game.players.O]) {
                if (player) player.socketId = null;
            }
            game.roundNumber = Number.isInteger(game.roundNumber) && game.roundNumber >= 1 ? game.roundNumber : 1;
            game.starter = game.starter === 'O' ? 'O' : 'X';
            game.score = game.score || { X: 0, O: 0, draws: 0 };
            game.nextRoundAt = Number.isFinite(game.nextRoundAt) ? game.nextRoundAt : null;
            return game;
        });
    }

    return {
        enabled: true,
        load,
        save: (game) => saveStatement.run(game.id, JSON.stringify(snapshot(game)), game.updatedAt),
        delete: (roomId) => deleteStatement.run(roomId),
        close: () => db.close()
    };
}

module.exports = { createRoomStore };
