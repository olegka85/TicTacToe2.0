'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateTelegramUser, moveWord, formatRoundMessage, sendBotMessage } = require('./telegram-notifications');

const token = '123456:TEST-SECRET';
const authDate = Math.floor(Date.now() / 1000);
function sign(values) {
    const params = new URLSearchParams(values);
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => k + '=' + v).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
    return params.toString();
}
const raw = sign({ auth_date: String(authDate), user: JSON.stringify({ id: 1100220033, first_name: 'Марина' }) });
assert.deepEqual(validateTelegramUser(raw, token, authDate), { id: 1100220033, firstName: 'Марина' });
const tampered = new URLSearchParams(raw);
tampered.set('user', JSON.stringify({ id: 1100220033, first_name: 'Другая' }));
assert.equal(validateTelegramUser(tampered.toString(), token, authDate), null);
assert.equal(validateTelegramUser(raw, 'another-token', authDate), null);
assert.equal(validateTelegramUser(raw, token, authDate + 86401), null);
assert.equal(validateTelegramUser('', token, authDate), null);
assert.equal(moveWord(1), 'ход');
assert.equal(moveWord(2), 'хода');
assert.equal(moveWord(7), 'ходов');
assert.equal(moveWord(21), 'ход');
assert.equal(moveWord(12), 'ходов');
const win = formatRoundMessage({ won: true, draw: false, opponentName: 'Марина', winnerMoves: 7, roomId: 'A2B3C4' });
assert.match(win.text, /победили за 7 ходов/);
assert.match(win.url, /room=A2B3C4/);
const lose = formatRoundMessage({ won: false, draw: false, opponentName: 'Марина', roomId: 'A2B3C4' });
assert.doesNotMatch(lose.text, /проиграли|победил|проигрыш/);
const draw = formatRoundMessage({ won: false, draw: true, opponentName: 'Марина', roomId: 'A2B3C4' });
assert.match(draw.text, /Ничья/);
(async () => {
    let payload;
    assert.equal(await sendBotMessage(1100220033, win, token, async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true };
    }), true);
    assert.equal(payload.chat_id, 1100220033);
    assert.equal(payload.reply_markup.inline_keyboard[0][0].text, '🎮 Играть ещё');
    assert.equal(payload.reply_markup.inline_keyboard[0][0].web_app.url, win.url);
    assert.equal(await sendBotMessage(0, win, token, async () => { throw Error('must not send'); }), false);
    console.log('Telegram round notification tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
