# Инструкция по запуску мультиплеерной игры "Крестики-Нолики 2.0"

## 📋 Что вам нужно для игры на двух разных устройствах

Для игры между двумя устройствами (телефонами, планшетами, компьютерами) необходим **сервер**, который будет синхронизировать ходы между игроками через интернет.

---

## 🚀 Шаг 1: Развёртывание сервера

### Вариант А: Бесплатный хостинг на Render.com (рекомендуется)

1. **Зарегистрируйтесь на [Render.com](https://render.com)**
   - Войдите через GitHub аккаунт

2. **Создайте новый репозиторий на GitHub** с вашими файлами:
   ```
   /workspace/
   ├── index.html          # Файл игры
   └── server/
       ├── package.json    # Зависимости Node.js
       └── server.js       # Серверный код
   ```

3. **Создайте Web Service на Render:**
   - Нажмите "New +" → "Web Service"
   - Подключите ваш GitHub репозиторий
   - Настройки:
     - **Name**: `ultimate-tic-tac-toe-server`
     - **Environment**: `Node`
     - **Build Command**: `cd server && npm install`
     - **Start Command**: `cd server && node server.js`
     - **Instance Type**: `Free`

4. **После развёртывания** вы получите URL вида:
   ```
   https://ultimate-tic-tac-toe-server.onrender.com
   ```

### Вариант Б: Локальный запуск для тестирования

```bash
# Установите Node.js если ещё не установлен
# Затем выполните:

cd /workspace/server
npm install
npm start
```

Сервер запустится на `http://localhost:3000`

---

## 🔧 Шаг 2: Обновление файла index.html

Откройте файл `/workspace/index.html` и найдите строки (примерно 350 и 374):

```javascript
const serverUrl = 'https://your-server-url.com'; // Замените на ваш URL после деплоя
```

**Замените** `https://your-server-url.com` на URL вашего сервера:

```javascript
const serverUrl = 'https://ultimate-tic-tac-toe-server.onrender.com';
```

Или для локального тестирования:
```javascript
const serverUrl = 'http://localhost:3000';
```

---

## 🌐 Шаг 3: Размещение frontend (index.html)

### Вариант А: GitHub Pages (бесплатно)

1. Загрузите `index.html` в корень GitHub репозитория
2. Перейдите в Settings → Pages
3. Включите GitHub Pages для ветки `main`
4. Получите URL: `https://ваш-username.github.io/ваш-репозиторий/`

### Вариант Б: Netlify (бесплатно)

1. Зайдите на [Netlify Drop](https://app.netlify.com/drop)
2. Перетащите папку с `index.html`
3. Получите URL вида: `https://random-name.netlify.app`

### Вариант В: Vercel (бесплатно)

1. Установите Vercel CLI: `npm i -g vercel`
2. Выполните в папке с `index.html`: `vercel`
3. Следуйте инструкциям

---

## 🎮 Как играть

### Игрок 1 (создаёт игру):
1. Откройте приложение на своём устройстве
2. Нажмите **"🆕 Создать игру"**
3. Скопируйте код игры (6 символов)
4. Отправьте код второму игроку (Telegram, WhatsApp, etc.)

### Игрок 2 (присоединяется):
1. Откройте приложение на своём устройстве
2. Нажмите **"🎮 Войти в игру"**
3. Введите код игры от первого игрока
4. Нажмите **"🎮 Войти"**

### Игра началась!
- Первый игрок всегда играет за **X**
- Второй игрок играет за **O**
- Статус подключения показывается внизу экрана
- При победе — салют и поздравление!

---

## 📱 Интеграция с Telegram Web App

1. Создайте бота через [@BotFather](https://t.me/botfather)
2. Используйте команду `/newapp`
3. Укажите URL вашего frontend (GitHub Pages, Netlify, etc.)
4. BotFather даст вам ссылку вида: `https://t.me/yourbot/appname`

Теперь игроки могут запускать игру прямо из Telegram!

---

## 📲 Установка как мобильное приложение (PWA)

### Android (Chrome):
1. Откройте сайт в Chrome
2. Нажмите меню (три точки) → "Установить приложение" или "Добавить на главный экран"
3. Подтвердите установку

### iOS (Safari):
1. Откройте сайт в Safari
2. Нажмите кнопку "Поделиться" (квадрат со стрелкой)
3. Выберите "На экран «Домой»"
4. Подтвердите добавление

---

## 🛠 Публикация в магазинах приложений

### Google Play (Android):

1. **Создайте проект в [Google Play Console](https://play.google.com/console)**
   - Стоимость регистрации: $25 (единоразово)

2. **Оберните веб-приложение в APK:**
   
   **Вариант A: Bubblewrap (рекомендуется)**
   ```bash
   npm install -g @bubblewrap/cli
   bubblewrap init --manifest https://your-url.com/manifest.json
   bubblewrap build
   ```
   
   **Вариант B: Capacitor**
   ```bash
   npm install -g @capacitor/cli @capacitor/core
   npx cap init
   npx cap add android
   npx cap sync
   npx cap open android
   ```
   Затем откройте Android Studio и экспортируйте APK/AAB

3. **Заполните информацию о приложении:**
   - Название, описание, скриншоты
   - Категория: "Игры" → "Настольные"
   - Возрастной рейтинг: "3+"

4. **Загрузите APK/AAB файл** и отправьте на модерацию

### Apple App Store (iOS):

1. **Зарегистрируйтесь в [Apple Developer Program](https://developer.apple.com)**
   - Стоимость: $99/год

2. **Создайте проект в Xcode:**
   
   **Вариант A: Capacitor**
   ```bash
   npm install -g @capacitor/cli @capacitor/core
   npx cap init
   npx cap add ios
   npx cap sync
   npx cap open ios
   ```
   Откроется Xcode
   
   **Вариант B: Native iOS app with WKWebView**
   - Создайте новый проект в Xcode
   - Добавьте WKWebView для отображения вашего сайта

3. **Настройте проект:**
   - Bundle Identifier: `com.yourcompany.tictactoe2`
   - Version: 1.0.0
   - Build: 1

4. **Подготовьте материалы для App Store:**
   - Скриншоты для всех размеров iPhone/iPad
   - Описание, ключевые слова
   - Иконка 1024x1024 px

5. **Создайте запись в App Store Connect:**
   - Заполните всю информацию
   - Загрузите сборку через Xcode или Transporter

6. **Отправьте на ревью** (обычно 1-3 дня)

---

## ⚠️ Важные замечания

1. **HTTPS обязателен** для работы Socket.io и Telegram Web App
2. **Бесплатный тариф Render** может "засыпать" после 15 минут бездействия (первый запрос будет долгим)
3. Для продакшена рекомендуется **платный хостинг** или свой VPS
4. Не забудьте создать файл `manifest.json` для PWA функциональности

---

## 📞 Поддержка

Если возникнут проблемы:
1. Проверьте консоль браузера (F12) на ошибки
2. Убедитесь, что сервер запущен и доступен
3. Проверьте, что URL сервера правильно указан в index.html

Приятной игры! 🎉
