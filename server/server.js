const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Хранилище игр в памяти (для продакшена лучше использовать Redis или базу данных)
const games = {};

io.on('connection', (socket) => {
  console.log(`Игрок подключился: ${socket.id}`);

  // Создание новой игры
  socket.on('createGame', () => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    games[roomId] = {
      id: roomId,
      players: {
        X: socket.id,
        O: null
      },
      currentPlayer: 'X',
      smallBoards: Array(9).fill(null).map(() => Array(9).fill(null)),
      bigBoard: Array(9).fill(null),
      nextBoard: null, // null означает, что можно ходить куда угодно
      gameActive: true,
      winner: null,
      createdAt: Date.now()
    };

    socket.join(roomId);
    socket.emit('gameCreated', { roomId, playerId: 'X' });
    console.log(`Игра создана: ${roomId}`);
  });

  // Присоединение к игре
  socket.on('joinGame', (roomId) => {
    const game = games[roomId];
    
    if (!game) {
      socket.emit('error', 'Игра не найдена');
      return;
    }

    if (game.players.O !== null) {
      socket.emit('error', 'Игра уже заполнена');
      return;
    }

    game.players.O = socket.id;
    socket.join(roomId);
    socket.emit('gameJoined', { roomId, playerId: 'O' });
    
    // Уведомляем обоих игроков о начале игры
    io.to(roomId).emit('gameStart', {
      players: game.players,
      currentPlayer: game.currentPlayer
    });
    
    console.log(`Игрок присоединился к игре: ${roomId}`);
  });

  // Обработка хода
  socket.on('makeMove', ({ roomId, cellIndex, playerId }) => {
    const game = games[roomId];
    
    if (!game || !game.gameActive) {
      socket.emit('error', 'Игра не активна');
      return;
    }

    // Проверка, что ход делает правильный игрок
    if ((playerId === 'X' && socket.id !== game.players.X) || 
        (playerId === 'O' && socket.id !== game.players.O)) {
      socket.emit('error', 'Не ваш ход');
      return;
    }

    if (game.currentPlayer !== playerId) {
      socket.emit('error', 'Сейчас не ваш ход');
      return;
    }

    // Проверка, что ход разрешён в это поле
    if (game.nextBoard !== null) {
      const boardIndex = Math.floor(cellIndex / 9);
      if (boardIndex !== game.nextBoard) {
        socket.emit('error', `Нужно ходить в поле ${game.nextBoard + 1}`);
        return;
      }
    }

    // Проверка, что клетка свободна
    if (game.smallBoards[cellIndex] !== null) {
      socket.emit('error', 'Клетка занята');
      return;
    }

    // Совершаем ход
    game.smallBoards[cellIndex] = playerId;
    
    // Проверяем победу в малом поле 3x3
    const boardIndex = Math.floor(cellIndex / 9);
    const boardStart = boardIndex * 9;
    const boardCells = game.smallBoards.slice(boardStart, boardStart + 9);
    
    const winPatterns = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // горизонтали
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // вертикали
      [0, 4, 8], [2, 4, 6]             // диагонали
    ];

    let boardWinner = null;
    for (const pattern of winPatterns) {
      const [a, b, c] = pattern;
      if (boardCells[a] && boardCells[a] === boardCells[b] && boardCells[a] === boardCells[c]) {
        boardWinner = playerId;
        break;
      }
    }

    if (boardWinner) {
      game.bigBoard[boardIndex] = boardWinner;
      game.gameActive = false;
      game.winner = boardWinner;
      
      io.to(roomId).emit('gameOver', {
        winner: boardWinner,
        winningBoard: boardIndex
      });
      console.log(`Игра ${roomId} завершена. Победитель: ${boardWinner}`);
      return;
    }

    // Проверяем ничью (все клетки заполнены)
    if (!game.smallBoards.includes(null)) {
      game.gameActive = false;
      io.to(roomId).emit('gameOver', { winner: 'draw' });
      console.log(`Игра ${roomId} завершена вничью`);
      return;
    }

    // Определяем следующее поле для хода
    const nextCellInSmallBoard = cellIndex % 9;
    if (game.bigBoard[nextCellInSmallBoard] === null) {
      game.nextBoard = nextCellInSmallBoard;
    } else {
      game.nextBoard = null; // Можно ходить куда угодно
    }

    // Передаём ход другому игроку
    game.currentPlayer = playerId === 'X' ? 'O' : 'X';

    // Отправляем обновлённое состояние всем игрокам
    io.to(roomId).emit('moveMade', {
      cellIndex,
      playerId,
      nextBoard: game.nextBoard,
      currentPlayer: game.currentPlayer,
      smallBoards: game.smallBoards,
      bigBoard: game.bigBoard
    });
  });

  // Игрок отключился
  socket.on('disconnect', () => {
    console.log(`Игрок отключился: ${socket.id}`);
    
    // Находим игру, в которой был этот игрок
    for (const roomId in games) {
      const game = games[roomId];
      if (game.players.X === socket.id || game.players.O === socket.id) {
        io.to(roomId).emit('playerDisconnected', {
          playerId: game.players.X === socket.id ? 'X' : 'O'
        });
        
        // Очищаем игру через 5 минут
        setTimeout(() => {
          delete games[roomId];
          console.log(`Игра ${roomId} удалена`);
        }, 300000);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
