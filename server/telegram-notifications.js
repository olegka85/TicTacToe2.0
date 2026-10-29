'use strict';

const crypto = require('node:crypto');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GAME_URL = process.env.TTT20_GAME_URL || 'https://ttt20.peerivo.net/';

// Authenticate Telegram Mini App identity server-side; initDataUnsafe must never be trusted.
function validateTelegramUser(initData, token = BOT_TOKEN, now = Math.floor(Date.now() / 1000)) {
    if (!token || typeof initData !== 'string' || !initData || initData.length > 10000) return null;
    try {
        const params = new URLSearchParams(initData);
        const entries = [...params.entries()];
        if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
        const hash = params.get('hash') || '';
        const authDate = Number(params.get('auth_date'));
        if (!/^[0-9a-f]{64}$/i.test(hash) || !Number.isSafeInteger(authDate) ||
            authDate > now + 300 || now - authDate > 24 * 60 * 60) return null;
        const dataCheckString = entries
            .filter(([key]) => key !== 'hash' && key !== 'signature')
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, value]) => key + '=' + value)
            .join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
        if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return null;
        const user = JSON.parse(params.get('user') || 'null');
        if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) return null;
        return {
            id: user.id,
            firstName: typeof user.first_name === 'string'
                ? user.first_name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64)
                : ''
        };
    } catch (_) {
        return null;
    }
}

function moveWord(n) {
    const lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 14) return 'ходов';
    if (n % 10 === 1) return 'ход';
    return n % 10 >= 2 && n % 10 <= 4 ? 'хода' : 'ходов';
}

function formatRoundMessage({ won, draw, opponentName, winnerMoves, roomId }) {
    const against = opponentName ? 'с игроком «' + opponentName + '»' : 'с соперником';
    let message;
    if (draw) {
        message = '🤝 Ничья!\n\nВы играли ' + against +
            '. Победителя в этой партии нет.\n\nМожет, сыграем ещё? 🎮';
    } else if (won) {
        message = '🏆 Отличная партия!\n\nВы играли ' + against +
            ' и победили за ' + winnerMoves + ' ' + moveWord(winnerMoves) +
            '!\n\nГотовы к следующему раунду? 🎮';
    } else {
        message = '🎮 Партия завершена!\n\nВы играли ' + against +
            '.\n\nПопробуйте ещё раз — следующая партия уже ждёт!';
    }
    const link = new URL(GAME_URL);
    if (roomId) link.searchParams.set('room', roomId);
    return { text: message, url: link.toString() };
}

async function sendBotMessage(chatId, message, token = BOT_TOKEN, transport = globalThis.fetch) {
    if (!token || !Number.isSafeInteger(chatId) || chatId <= 0) return false;
    try {
        const response = await transport('https://api.telegram.org/bot' + token + '/sendMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
                chat_id: chatId,
                text: message.text,
                reply_markup: {
                    inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: message.url } }]]
                }
            })
        });
        if (!response.ok) {
            console.warn('Telegram result notification rejected (HTTP ' + response.status + ')');
            return false;
        }
        return true;
    } catch (error) {
        console.warn('Telegram result notification failed (' + (error.name || 'Error') + ')');
        return false;
    }
}

function notifyCompletedRound(game) {
    if (!BOT_TOKEN) return;
    const winner = game.state.winner;
    const winnerMoves = (game.state.smallBoards || []).flat().filter((value) => value === winner).length;
    const recipients = new Set();
    for (const playerId of ['X', 'O']) {
        const player = game.players[playerId];
        const telegram = player && player.telegram;
        if (!telegram || recipients.has(telegram.id)) continue;
        recipients.add(telegram.id);
        const opponent = game.players[playerId === 'X' ? 'O' : 'X'];
        const opponentName = opponent && opponent.telegram && opponent.telegram.firstName;
        const message = formatRoundMessage({
            won: winner === playerId,
            draw: winner === 'draw',
            opponentName,
            winnerMoves,
            roomId: game.id
        });
        // Dispatch asynchronously: a slow Telegram API must never hold up a move or auto-restart.
        void sendBotMessage(telegram.id, message);
    }
}

module.exports = {
    validateTelegramUser,
    moveWord,
    formatRoundMessage,
    sendBotMessage,
    notifyCompletedRound
};
